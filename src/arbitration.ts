import type { Constraint, Tier } from "./adapters/types.ts";
import { GENERALIZER, hasNegation, NON_SUBJECT } from "./lexicon.ts";

export interface EpistemicConflictError {
  error: "EpistemicConflictError";
  /** Who decided. Absent means the local heuristic. */
  source?: "cloud";
  trace_id?: string;
  attempted: { tier: Tier; content: string; scope?: string };
  conflicts_with: { tier: Tier; id: string; content: string; scope?: string; recorded_at: string };
  reason: string;
  resolution: string;
}

export interface Attempt { tier: Tier; content: string; scope?: string }

export function subjectTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/<!--.*?-->/g, "")
      .split(/[^\p{L}\p{N}_.-]+/u)
      .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
      .filter((t) => t.length > 1 && !NON_SUBJECT.has(t)),
  );
}

/** Overlap coefficient: |A∩B| / min(|A|,|B|). A short claim about the same subject scores high. */
export function subjectOverlap(a: string, b: string): number {
  const A = subjectTokens(a), B = subjectTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** v0 heuristic arbitration. Cloud arbitration replaces the judge; the interface stays. */
export function arbitrate(attempt: Attempt, constraints: Constraint[], threshold = 0.5): EpistemicConflictError | null {
  for (const c of constraints) {
    if (subjectOverlap(attempt.content, c.content) < threshold) continue;

    const generalizes = GENERALIZER.test(attempt.content);
    const generalizesScoped = c.tier === "DECISION" && !!c.scope && !attempt.scope && generalizes;
    const polarityFlip = c.tier === "DIRECTIVE" && hasNegation(attempt.content) !== hasNegation(c.content);
    const lowerTierOverridesDirective = c.tier === "DIRECTIVE" && attempt.tier !== "DIRECTIVE" && generalizes;

    if (generalizesScoped || polarityFlip || lowerTierOverridesDirective) {
      return {
        error: "EpistemicConflictError",
        attempted: { tier: attempt.tier, content: attempt.content, ...(attempt.scope ? { scope: attempt.scope } : {}) },
        conflicts_with: { tier: c.tier, id: c.id, content: c.content, ...(c.scope ? { scope: c.scope } : {}), recorded_at: c.recordedAt },
        reason: generalizesScoped
          ? `Attempting to generalize a scoped ${c.tier} ("${c.scope}") into an unscoped claim.`
          : polarityFlip
            ? "Polarity contradicts an active DIRECTIVE."
            : "A lower-tier record cannot override a DIRECTIVE.",
        resolution: "Ask the user, or narrow the claim to the constraint's scope.",
      };
    }
  }
  return null;
}
