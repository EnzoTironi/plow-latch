import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach } from "vitest";
import type { CredentialCodec } from "@domo/owner-core/settings";
import { createHostBinding } from "@domo/owner-runtime";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

export function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "latch-owner-services-"));
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

export function disposeAfterTest(dispose: () => void | Promise<void>): void { cleanup.push(dispose); }

export function encryptedFixtureCodec(): CredentialCodec {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt: (plaintext) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    decrypt: (sealed) => {
      const bytes = Buffer.from(sealed, "base64");
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}

export function ownerBinding(ownerId = "owner-fixture", organizationId = "org-fixture") {
  const transport = new AbortController();
  const binding = createHostBinding({
    organizationId, ownerId, userId: "user-fixture", principalId: "principal-fixture",
    connectionId: "connection-fixture", enrollmentRevision: 1,
    expiresAt: Date.now() + 60_000, assurance: "trusted_host_form",
  }, { signal: transport.signal, isCurrent: () => true, verifyResponse: async () => ({ evidenceRef: "isolated-fixture" }) });
  return { binding, transport };
}
