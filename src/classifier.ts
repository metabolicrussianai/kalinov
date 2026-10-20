import type { Tier, TierMeta } from "./adapters/types.ts";
import { isHedged, userProvenance } from "./provenance.ts";
import { ENV_MARKERS, GENERALIZER, SCOPE_MARKERS, USER_PREFIX, USER_QUOTE } from "./lexicon.ts";

export interface ClassifyInput {
  content: string;
  /** Tier the agent itself claims, if the write tool carries one (e.g. params.kalinov_tier). */
  claimedTier?: Tier;
  scope?: string;
  /** The user's actual message for this turn, when the host grants conversation access. Enables verified provenance. */
  userText?: string;
}

/** Below this, the local verdict is a guess and a cloud arbitrator (if configured) may be asked. */
export const UNCERTAIN_BELOW = 0.7;

export interface ClassifyResult {
  tier: Tier;
  scope?: string;
  reason: string;
  downgraded: boolean;
  /** 0..1: how much evidence backs the tier. Explicit quote .95, verified provenance .76-1, env marker .85, scope marker .8, hedged .85, generalizing .6, no evidence .5. */
  confidence: number;
  /** confidence < UNCERTAIN_BELOW. Callers with a different threshold recompute from `confidence`. */
  uncertain: boolean;
}

const conf = (confidence: number) => ({ confidence, uncertain: confidence < UNCERTAIN_BELOW });

export function classify(input: ClassifyInput): ClassifyResult {
  const text = input.content.trim();
  const hasUserEvidence = USER_QUOTE.test(text) || USER_PREFIX.test(text);
  const generalizes = GENERALIZER.test(text);
  const scope = input.scope ?? SCOPE_MARKERS.exec(text)?.[0]?.trim();

  if (input.claimedTier === "DIRECTIVE" && !hasUserEvidence) {
    return { tier: "HYPOTHESIS", reason: "claimed DIRECTIVE without user quote evidence", downgraded: true, ...conf(0.9) };
  }
  if (hasUserEvidence) {
    return scope
      ? { tier: "DECISION", scope, reason: "user quote with scope", downgraded: false, ...conf(0.95) }
      : { tier: "DIRECTIVE", reason: "explicit user quote", downgraded: false, ...conf(0.95) };
  }
  if (ENV_MARKERS.test(text) && !generalizes) {
    return { tier: "OBSERVATION", reason: "environment marker", downgraded: input.claimedTier === "DECISION", ...conf(0.85) };
  }
  const prov = userProvenance(text, input.userText);
  if (prov.fromUser) {
    const sc = scope ?? prov.scope;
    const c = conf(Math.min(1, 0.6 + prov.coverage * 0.4));
    return sc
      ? { tier: "DECISION", scope: sc, reason: `verified against the user's message (coverage ${prov.coverage.toFixed(2)}), scoped`, downgraded: false, ...c }
      : { tier: "DIRECTIVE", reason: `verified against the user's message (coverage ${prov.coverage.toFixed(2)})`, downgraded: false, ...c };
  }
  if (scope && !generalizes) {
    return { tier: "DECISION", scope, reason: "scope marker", downgraded: false, ...conf(0.8) };
  }
  return {
    tier: "HYPOTHESIS",
    reason: generalizes ? "generalizing claim without user evidence" : "no evidence markers",
    downgraded: input.claimedTier !== undefined && input.claimedTier !== "HYPOTHESIS",
    ...conf(isHedged(text) ? 0.85 : generalizes ? 0.6 : 0.5),
  };
}

export function buildMeta(r: ClassifyResult, session: number, turnId: string | undefined, ttlSessions: number): TierMeta {
  const meta: TierMeta = { tier: r.tier, recordedAt: new Date().toISOString(), recordedSession: session };
  if (r.tier === "HYPOTHESIS") meta.expiresAfterSessions = ttlSessions;
  if (r.scope) meta.scope = r.scope;
  if (turnId) meta.sourceTurnId = turnId;
  return meta;
}
