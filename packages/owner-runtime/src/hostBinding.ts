import { z } from "zod";
import { EnrollmentSchema, OwnerError, parse, reference } from "./types.js";
import type { HostResponse, OwnerChallenge, VerifiedHostEnrollment } from "./types.js";

const bindings = new WeakSet<HostBinding>();
const evidence = z.object({ evidenceRef: reference }).strict();

export interface HostTransport {
  signal: AbortSignal;
  isCurrent(): boolean;
  verifyResponse(challenge: OwnerChallenge, response: HostResponse): Promise<{ evidenceRef: string } | null>;
  requestForm?(challenge: OwnerChallenge, signal: AbortSignal): Promise<unknown>;
}

export class HostBinding {
  private constructor(readonly enrollment: Readonly<VerifiedHostEnrollment>, readonly transport: HostTransport) {}

  /** Bootstrap calls this only after its enrollment verifier authenticates the owner and host connection. */
  static fromVerifiedEnrollment(enrollment: VerifiedHostEnrollment, transport: HostTransport): HostBinding {
    const binding = new HostBinding(Object.freeze(parse(EnrollmentSchema, enrollment)), transport);
    bindings.add(binding);
    return binding;
  }
}

/** This constructor belongs to trusted bootstrap code, never to an MCP argument or UI data parser. */
export const createHostBinding = HostBinding.fromVerifiedEnrollment;

export function requireBinding(binding: HostBinding | null | undefined, now: number): HostBinding {
  if (!binding || !bindings.has(binding) || binding.transport.signal.aborted || !binding.transport.isCurrent() || binding.enrollment.expiresAt <= now) {
    throw new OwnerError("owner_not_enrolled");
  }
  return binding;
}

export async function verifyHostResponse(binding: HostBinding, challenge: OwnerChallenge, response: HostResponse, now: () => number): Promise<string> {
  requireBinding(binding, now());
  const result = await binding.transport.verifyResponse(challenge, response);
  requireBinding(binding, now());
  if (result === null) throw new OwnerError("owner_not_enrolled");
  return parse(evidence, result).evidenceRef;
}
