/**
 * How an operation intent gets decided — the branching between approval mode,
 * credential availability, and the human dialog.
 *
 * This lives outside the Electron entry on purpose (same reason as
 * `viewModel.ts` and `spawnAgent.ts`): it is the security-relevant decision
 * path, so it has to be reachable by `npx vitest run` with no display and no
 * device. `main.ts` keeps only the Electron-shaped adapter around it.
 */
import { Intent, JSONValue } from "@domo/protocol";
import {
  APPROVAL_SOURCE_PLOW_FOLDER,
  confinedToPlowFolder,
  DENIAL_SOURCE_NO_CREDITS,
  DENIAL_SOURCE_NO_REVIEWER,
  DENIAL_SOURCE_REVIEWER_UNAVAILABLE,
} from "@domo/device-core";
import {
  REVIEWER_MODEL,
  ReviewArgs,
  ReviewFailureCause,
  Verdict,
} from "./adversarialAgent.js";
import { DEFAULT_APPROVAL_MODE, Settings } from "./settings.js";

export type ApprovalDecision = "allow_once" | "always_allow" | "deny";

/**
 * What the reviewer has to say to the human, when a human is being asked.
 *
 * **Display-only, both halves.** `decision` highlights a button and `reason`
 * is text to read; neither touches the capability set, which is what the
 * sandbox is built from and the only thing the dialog presents as enforceable.
 */
export interface ReviewHint {
  /** The button to highlight, or null when the reviewer reached no verdict. */
  decision: ApprovalDecision | null;
  /** Why — in the reviewer's words, or ours when it could not answer. */
  reason: string;
}

/**
 * What the renderer is allowed to know about inference: whether the reviewer
 * can run. **No credentials** — not the relay credential, not a prefix of one.
 */
export interface InferenceStatus {
  /** Whether this Mac holds the credential the reviewer needs. */
  available: boolean;
  /**
   * The stored approval mode, in the SAME snapshot as availability. Reading the
   * two separately gave the renderer two async views of one settings file, and
   * a window where they disagreed.
   */
  approvalMode: Settings["approvalMode"];
}

/** The renderer-facing shape. Built here so there is one definition of "safe". */
export function inferenceStatus(settings: Settings): InferenceStatus {
  return {
    available: reviewerAvailable(settings),
    approvalMode: settings.approvalMode ?? DEFAULT_APPROVAL_MODE,
  };
}

/** Can the reviewer run at all right now? Exactly: is this Mac signed in. */
export function reviewerAvailable(settings: Settings): boolean {
  return !!(settings.relayCredential ?? "").trim();
}

/**
 * May a stored always-allow rule answer on its own?
 *
 * Only under the modes that would let a cached human decision stand. A rule is
 * one human decision replayed, and the policy engine replays it BEFORE any
 * delegate is consulted — so a mode that takes the decision away from the
 * human has to say so here or be bypassed by every operation they ever pressed
 * "always allow" on.
 *
 * Two modes take it away. `adversarial` gives it to the reviewer; `deny`
 * refuses everything, and a cached allow must not outrank it.
 *
 * Refusing here is not itself a denial. It routes the intent down the normal
 * path, where `decideIntent` runs the review or denies as the mode requires.
 */
export function storedRuleMayGrant(settings: Settings): boolean {
  const mode = settings.approvalMode ?? DEFAULT_APPROVAL_MODE;
  return mode !== "adversarial" && mode !== "deny";
}

/**
 * A decision and HOW it was reached, for the audit log — and, on an
 * `always_allow`, whether its rule is already in place (stored by the dialog
 * path, or the rule that answered), so the engine does not store it again
 * (PolicyEngine's `IntentDecision`).
 */
export type Decided = { decision: ApprovalDecision; source: string; ruleStored?: true; reason?: string };

/** A request waiting its turn for the human. */
export interface QueuedApproval {
  /**
   * Answer without a dialog, if something decided this request while it
   * waited — a rule stored by an "always allow" ahead of it. Null: wait.
   */
  preempt: () => Promise<Decided | null>;
  /** Show the dialog. Runs only when no other dialog is open. */
  show: () => Promise<Decided>;
}

/**
 * One dialog at a time. Two approval windows must never overlap, so every
 * request waits its turn here. A request is `preempt`ed rather than shown
 * whenever something has already decided it: `sweep` asks every waiting
 * request at once, the moment a rule is stored, so [A, B, A] answered
 * "always allow" on the first A leaves the human with [B] — the second A is
 * granted right then, not when its turn would have come. The head of the
 * line is asked once more before its dialog opens, for a rule that landed
 * between a sweep and its turn. A dialog that throws fails its own request
 * and nothing behind it.
 */
export class ApprovalQueue {
  private busy = false;
  private line: { entry: QueuedApproval; resolve: (d: Decided) => void; reject: (e: unknown) => void }[] = [];

  run(entry: QueuedApproval): Promise<Decided> {
    return new Promise<Decided>((resolve, reject) => {
      this.line.push({ entry, resolve, reject });
      void this.advance();
    });
  }

  /** Something may now answer waiting requests: settle every one it does, in place. */
  async sweep(): Promise<void> {
    for (const waiting of [...this.line]) {
      const answer = await waiting.entry.preempt().catch(() => null);
      if (answer === null) continue;
      const at = this.line.indexOf(waiting);
      if (at < 0) continue; 
      this.line.splice(at, 1);
      waiting.resolve(answer);
    }
  }

  private async advance(): Promise<void> {
    if (this.busy) return;
    const next = this.line.shift();
    if (!next) return;
    this.busy = true;
    try {
      next.resolve((await next.entry.preempt()) ?? (await next.entry.show()));
    } catch (e) {
      next.reject(e);
    } finally {
      this.busy = false;
      void this.advance();
    }
  }
}

/** Everything `decideIntent` needs from the outside world, injected for tests. */
export interface DecideDeps {
  settings: Settings;
  /** Plow API origin. Baked into the build, never a setting. */
  apiBaseUrl: string;
  /**
   * The owner's `~/Plow` folder — the playground. File operations confined to
   * it are granted without a reviewer or a dialog (see `confinedToPlowFolder`
   * for what "confined" refuses). Deny mode outranks it.
   */
  plowRoot: string;
  /**
   * The audit log's current entries. NOT review context any more — nothing
   * below reads this, and the reviewer is handed `history: []` (DESIGN.md
   * §4). It comes out with `ReviewArgs.history` (#140).
   */
  auditEntries: () => JSONValue[];
  record: (event: string, fields: Record<string, JSONValue>) => void;
  review: (
    args: ReviewArgs,
  ) => Promise<{
    verdict: Verdict;
    reason: string;
    cause?: ReviewFailureCause;
  }>;
  /**
   * Show the human the approval dialog, optionally with the reviewer's say.
   * Not serialized by the caller: `decideIntent` runs it through `queue`.
   */
  openApproval: (hint: Promise<ReviewHint> | null) => Promise<ApprovalDecision>;
  /** The one queue every dialog on this Mac goes through. */
  queue: ApprovalQueue;
  /**
   * Does a stored always-allow rule cover this intent NOW, under the current
   * mode? The policy engine asked once, before this delegate was consulted;
   * this asks again when the dialog's turn comes, because the answer can
   * have changed while it waited (the engine's `ruleAnswers`).
   */
  ruleAnswers: () => Promise<boolean>;
  /**
   * Store this intent's always-allow rule now (the engine's `storeRule`).
   * Called the moment the human answers "always allow", while the dialog
   * still holds the queue: the next dialog in line asks `ruleAnswers` as
   * soon as this one lets go, and the engine's own store, which waits for
   * the answer to travel back up through `decide`, comes a few microtasks
   * too late for it.
   */
  storeRule: () => void;
}

/**
 * Decide one intent. The returned `source` records HOW it was decided, for the
 * audit log.
 *
 * The adversarial-agent features need a Plow credential; without one,
 * adversarial mode denies (`DENIAL_SOURCE_NO_REVIEWER`) and Ask
 * mode's suggestions are skipped.
 */
export async function decideIntent(intent: Intent, deps: DecideDeps): Promise<Decided> {
  const { settings } = deps;
  const mode = settings.approvalMode ?? DEFAULT_APPROVAL_MODE;

  if (mode === "deny") return { decision: "deny", source: "policy" };

  if (await confinedToPlowFolder(intent.capabilities, deps.plowRoot)) {
    return { decision: "allow_once", source: APPROVAL_SOURCE_PLOW_FOLDER };
  }

  if (mode === "approve") return { decision: "allow_once", source: "approve" };

  const reviewDecides = mode === "adversarial";

  const humanAvailable = !reviewDecides;

  const review = async () => {
    deps.record("adversarial_review_started", {
      intentId: intent.intentId,
      agent: intent.agentId,
      model: REVIEWER_MODEL,
    });
    const r = await deps.review({
      intent,
      history: [],
      plowCredential: (settings.relayCredential ?? "").trim(),
      agentPurpose: settings.agentPurpose ?? "",
      apiBaseUrl: deps.apiBaseUrl,
      humanAvailable,
    });
    deps.record("adversarial_review_result", {
      intentId: intent.intentId,
      verdict: r.verdict,
      reason: r.reason,
      ...(r.cause ? { cause: r.cause } : {}),
    });
    return r;
  };

  if (reviewDecides) {
    if (!reviewerAvailable(settings)) {
      return { decision: "deny", source: DENIAL_SOURCE_NO_REVIEWER };
    }
    const { verdict, reason, cause } = await review();
    if (verdict === "allow")
      return { decision: "allow_once", source: "adversarial" };
    if (verdict === "deny") return { decision: "deny", source: "adversarial", reason };
    if (cause === "no_credits") {
      return { decision: "deny", source: DENIAL_SOURCE_NO_CREDITS };
    }
    return { decision: "deny", source: DENIAL_SOURCE_REVIEWER_UNAVAILABLE };
  }

  const hint =
    reviewerAvailable(settings)
      ? review().then((r) => ({
          decision:
            r.verdict === "allow"
              ? ("allow_once" as const)
              : r.verdict === "deny"
                ? ("deny" as const)
                : null,
          reason: r.reason,
        }))
      : null;
  return deps.queue.run({
    preempt: async () =>
      (await deps.ruleAnswers()) ? { decision: "always_allow", source: "rule", ruleStored: true } : null,
    show: async () => {
      const decision = await deps.openApproval(hint);
      if (decision === "always_allow") {
        deps.storeRule();
        await deps.queue.sweep();
        return { decision, source: "ask", ruleStored: true };
      }
      return { decision, source: "ask" };
    },
  });
}
