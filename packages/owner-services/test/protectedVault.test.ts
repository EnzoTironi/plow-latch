import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalVault, VaultKeyStore } from "@domo/device-core";
import type { JSONValue } from "@domo/protocol";
import { OwnerServices, StrictSettingsStore } from "../src/index.js";
import type { OwnerServicesOptions, ProtectedInputChannel } from "../src/index.js";
import { disposeAfterTest, ownerBinding, temporaryHome } from "./fixtures.js";

afterEach(() => vi.unstubAllEnvs());

function fixture(extra: Partial<OwnerServicesOptions> = {}) {
  vi.stubEnv("DOMO_VAULT_KEY_PROVIDER", "file");
  const home = temporaryHome();
  const directory = path.join(home, "isolated-vault");
  fs.mkdirSync(directory);
  const vault = new LocalVault(directory, new VaultKeyStore(directory, "owner-services-isolated-fixture"), path.join(directory, "credential-audit.log"));
  const services = new OwnerServices({ home, settings: new StrictSettingsStore({ home }), owner: { ownerId: "owner-fixture", organizationId: "org-fixture" }, vault: { client: vault, availability: () => ({ kind: "ready" }) }, ...extra });
  disposeAfterTest(() => services.close());
  return { services, vault, directory };
}

describe("protected owner vault boundary", () => {
  it("does not mark secret mutations ready solely because LocalVault exists", async () => {
    const { services } = fixture({ protectedSurface: { show: async () => ({ deliveryRef: "private-fixture" }) } });
    const { binding } = ownerBinding();
    for (const channel of ["vault:saveItem", "vault:importInspect", "vault:totp"]) {
      expect(services.registry(binding).find((entry) => entry.channel === channel)).toMatchObject({ data: "protected_owner", availability: { kind: "unavailable", reason: "protected_owner_input_required" } });
    }
    expect(() => services.command({ channel: "vault:saveItem", input: { type: "login", password: "fixture-plaintext" } }, 1)).toThrow("invalid_input");
    expect(() => services.command({ channel: "vault:importInspect", input: { text: "fixture-plaintext" } }, 1)).toThrow("invalid_input");
    expect(() => services.command({ channel: "vault:totp", input: { itemId: null, key: "JBSWY3DPEHPK3PXP" } }, 1)).toThrow("invalid_input");
  });

  it("saves and reveals actual encrypted vault items through tickets and private delivery", async () => {
    const { binding } = ownerBinding();
    const deliveries: JSONValue[] = [];
    const ticket = "private-ticket-fixture-0001";
    const pending = new Map<string, { channel: ProtectedInputChannel; input: JSONValue }>([[ticket, { channel: "vault:saveItem", input: { type: "login", name: "Owner fixture", username: "fixture-user", password: "vault_private_fixture_secret", urls: ["https://fixture.invalid"] } }]]);
    const { services, vault, directory } = fixture({
      protectedSurface: { show: async (owner, payload) => { expect(owner).toBe(binding); deliveries.push(payload); return { deliveryRef: `private-fixture-${deliveries.length}` }; } },
      protectedInput: {
        availability: () => ({ kind: "ready" }),
        consume: async (owner, channel, reference, signal) => {
          if (owner !== binding || signal.aborted) throw new Error("fixture ticket belongs to another owner");
          const staged = pending.get(reference);
          if (!staged || staged.channel !== channel) throw new Error("fixture ticket expired");
          pending.delete(reference);
          return staged.input;
        },
      },
    });
    const command = services.command({ channel: "vault:saveItem", input: { protectedInputTicket: ticket } }, 1);
    expect(JSON.stringify(command)).not.toContain("vault_private_fixture_secret");
    if (command.kind !== "native_control") throw new Error("fixture command kind");
    expect(await services.nativeAdapter(binding).perform(command, binding.transport.signal)).toEqual({ kind: "applied" });
    const items = await vault.list();
    expect(items).toMatchObject([{ title: "Owner fixture", subtitle: "fixture-user" }]);
    const item = items[0];
    if (!item) throw new Error("fixture item was not persisted");
    expect(await vault.reveal(item.id, "password")).toBe("vault_private_fixture_secret");
    expect(fs.readFileSync(path.join(directory, "items.json"), "utf8")).not.toContain("vault_private_fixture_secret");
    expect(await services.query(binding, { channel: "vault:items" })).toEqual({ kind: "unavailable", channel: "vault:items", reason: "protected_owner_surface_required" });
    const reveal = services.command({ channel: "vault:reveal", input: { itemId: item.id, field: "password" } }, 1);
    if (reveal.kind !== "native_control") throw new Error("fixture reveal command kind");
    const result = await services.nativeAdapter(binding).perform(reveal, binding.transport.signal);
    expect(result).toEqual({ kind: "applied" });
    expect(deliveries).toEqual([{ itemId: item.id, field: "password", value: "vault_private_fixture_secret" }]);
    expect(JSON.stringify(result)).not.toContain("vault_private_fixture_secret");
    expect(fs.readFileSync(path.join(directory, "credential-audit.log"), "utf8")).not.toContain("vault_private_fixture_secret");
    expect(await services.nativeAdapter(binding).perform(command, binding.transport.signal)).toEqual({ kind: "outcome_unknown" });
    expect(await vault.list()).toHaveLength(1);
  });

  it("keeps owner secrets closed when private delivery is unavailable", async () => {
    const { services, vault } = fixture();
    const { binding } = ownerBinding();
    const item = await vault.save({ type: "login", name: "Closed fixture", password: "closed_private_fixture_secret" });
    const command = services.command({ channel: "vault:reveal", input: { itemId: item.id, field: "password" } }, 1);
    if (command.kind !== "native_control") throw new Error("fixture command kind");
    expect(await services.nativeAdapter(binding).perform(command, binding.transport.signal)).toEqual({ kind: "unavailable", reason: "protected_owner_surface_required" });
  });
});
