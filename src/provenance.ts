import { SCOPE_MARKERS } from "./lexicon.ts";

/** Hedged speech is never a directive, even when it echoes the user's words. */
const HEDGE = /(?<![\p{L}\p{N}_])(?:suspect|suspects|guess|hypothes[ie]s|probably|likely|maybe|perhaps|might|i\s+think|seems?|предполагаю|предположительно|подозреваю|кажется|возможно|вероятно|наверное|гипотеза|думаю)(?![\p{L}\p{N}_])/iu;
export const isHedged = (s: string): boolean => HEDGE.test(s);

const STOP = new Set(["the","and","for","that","this","with","are","was","you","your","our","not","but","its","has","have","into","also","your","from","then","please","save","remember","memory","note","write","need","что","это","как","для","при","или","все","всё","чтобы","запомни","запиши","память","памяти","пожалуйста"]);

/** Token stems: lowercase, 5-char prefix for long words so Russian inflections ("прототипа"/"прототип") still match. */
export function stems(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().replace(/<!--.*?-->/g, " ").split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(raw.length > 5 ? raw.slice(0, 5) : raw);
  }
  return out;
}

/**
 * Two-sided overlap between the agent's line and the user's message.
 *   line:  share of the line's content words found in the user's message (is the line mostly the user's words?)
 *   user:  share of the user's content words found in the line (did the line keep what the user said?)
 */
export function overlap(line: string, userText: string): { line: number; user: number } {
  const L = stems(line), U = stems(userText);
  if (L.size === 0 || U.size === 0) return { line: 0, user: 0 };
  let hit = 0;
  for (const t of L) if (U.has(t)) hit++;
  return { line: hit / L.size, user: hit / U.size };
}

export interface Provenance { fromUser: boolean; scope?: string; coverage: number }

/**
 * Is this line (written by the agent) derived from what the user actually said this turn?
 * Verified against the real prompt, so it cannot be forged by phrasing the way a "User said:" marker can.
 */
/** The host prefixes prompts with an envelope such as "[Mon 2026-10-19 13:07 UTC] "; it is not the user's words. */
export const stripEnvelope = (s: string): string => s.replace(/^(?:\s*\[[^\]\n]{0,80}\]\s*)+/, "");

export function userProvenance(line: string, rawUserText: string | undefined, min = { line: 0.4, user: 0.6 }): Provenance {
  if (!rawUserText) return { fromUser: false, coverage: 0 };
  const userText = stripEnvelope(rawUserText);
  const o = overlap(line, userText);
  const c = Math.min(o.line, o.user);
  if (o.line < min.line || o.user < min.user || isHedged(line) || isHedged(userText)) return { fromUser: false, coverage: c };
  const scope = SCOPE_MARKERS.exec(line)?.[0]?.trim() ?? SCOPE_MARKERS.exec(userText)?.[0]?.trim();
  return { fromUser: true, coverage: c, ...(scope ? { scope } : {}) };
}
