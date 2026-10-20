import type { Constraint, TierMeta } from "./adapters/types.ts";
import type { PlanObserve } from "./stats.ts";
import { classify, buildMeta, UNCERTAIN_BELOW, type ClassifyResult } from "./classifier.ts";
import { arbitrate, subjectOverlap, type EpistemicConflictError } from "./arbitration.ts";
import { parseLine, stampLine, stripTag } from "./adapters/markdown.ts";
import { isHedged, overlap, stripEnvelope } from "./provenance.ts";

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const isContentLine = (l: string): boolean => l.trim() !== "" && !l.trimStart().startsWith("#") && !/^\s*<!--.*-->\s*$/.test(l);
const cleanText = (l: string): string => stripTag(l).replace(/<!--.*?-->/g, " ").replace(LIST_MARKER, "").replace(/\s+/g, " ").trim();
const key = (l: string): string => stripTag(l).trim();

export interface LineVerdict { line: string; result: ClassifyResult }
/** An uncertain line that is on the same subject as an active constraint but did not trip local arbitration. */
export interface GreyCase { line: string; result: ClassifyResult; related: Constraint[] }
/** A cloud verdict applied to a line (keyed by the line's cleaned text). */
export type Override = { tier: ClassifyResult["tier"]; scope?: string; reason: string; confidence: number };
/** `relatedOverlap`: minimum lexical overlap for a constraint to be attached to a grey line (default 0: rank, do not filter; paraphrases and translations share no words). `maxRelated`: constraints sent per line. */
export interface PlanOptions { overrides?: Map<string, Override>; uncertainBelow?: number; relatedOverlap?: number; maxRelated?: number; observe?: (ev: PlanObserve) => void }
export type WritePlan =
  | { ok: true; text: string; stamped: LineVerdict[]; grey: GreyCase[] }
  | { ok: false; conflict: EpistemicConflictError };

/**
 * Re-tier only what is new. Lines whose text already exists in `before` keep their original line
 * (including any existing Kalinov tag) — an agent rewriting MEMORY.md must never re-label old memory.
 */
export function planText(
  before: string,
  after: string,
  constraints: Constraint[],
  meta: (r: ClassifyResult) => TierMeta,
  userText?: string,
  opts: PlanOptions = {},
): WritePlan {
  const existing = new Map<string, string>();
  for (const l of before.split("\n")) if (isContentLine(l)) existing.set(key(l), l);

  // Records the agent removed from this text: candidates for "the user asked to amend this line".
  const afterKeys = new Set(after.split("\n").filter(isContentLine).map(key));
  const removed: Array<{ text: string; meta: TierMeta }> = [];
  for (const l of before.split("\n")) {
    if (!isContentLine(l) || afterKeys.has(key(l))) continue;
    const meta0 = parseLine(l);
    if (meta0 && (meta0.tier === "DIRECTIVE" || meta0.tier === "DECISION")) removed.push({ text: cleanText(l), meta: meta0 });
  }

  const out: string[] = [];
  const stamped: LineVerdict[] = [];
  const grey: GreyCase[] = [];
  const below = opts.uncertainBelow ?? UNCERTAIN_BELOW;
  for (const l of after.split("\n")) {
    if (!isContentLine(l)) { out.push(l); continue; }
    const prior = existing.get(key(l));
    if (prior !== undefined) { out.push(prior); continue; }
    const text = cleanText(l);
    let r = classify({ content: text, userText });
    const amended = r.tier === "HYPOTHESIS" ? amendment(text, removed, userText) : null;
    if (amended) r = amended;
    const ov = opts.overrides?.get(text);
    if (ov) r = { tier: ov.tier, ...(ov.scope ? { scope: ov.scope } : {}), reason: ov.reason, downgraded: false, confidence: ov.confidence, uncertain: false };
    const conflict = arbitrate({ tier: r.tier, content: text, scope: r.scope }, constraints);
    if (conflict) {
      opts.observe?.({ evaluated: 1, blocked: 1, uncertain: r.confidence < below ? 1 : 0 });
      return { ok: false, conflict };
    }
    out.push(stampLine(stripTag(l), meta(r)));
    stamped.push({ line: text, result: r });
    if (!ov && r.confidence < below) {
      const min = opts.relatedOverlap ?? 0;
      const related = constraints
        .map((c) => ({ c, o: subjectOverlap(text, c.content) }))
        .filter((x) => x.o >= min)
        .sort((a, b) => b.o - a.o)
        .slice(0, opts.maxRelated ?? 8)
        .map((x) => x.c);
      if (related.length) grey.push({ line: text, result: r, related });
    }
    opts.observe?.({
      evaluated: 1,
      blocked: 0,
      uncertain: r.confidence < below && !ov ? 1 : 0,
    });
  }
  return { ok: true, text: out.join("\n"), stamped, grey };
}

/** OpenClaw `edit` accepts {path, edits:[{oldText,newText}]} plus legacy top-level oldText/newText. */
export function normalizeEdits(params: Record<string, unknown>): Array<{ oldText: string; newText: string }> | null {
  let edits: unknown = params.edits;
  if (typeof edits === "string") { try { edits = JSON.parse(edits); } catch { edits = undefined; } }
  const list: Array<{ oldText: string; newText: string }> = [];
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (!e || typeof e !== "object") return null;
      const { oldText, newText } = e as Record<string, unknown>;
      if (typeof oldText !== "string" || typeof newText !== "string") return null;
      list.push({ oldText, newText });
    }
  }
  if (typeof params.oldText === "string" && typeof params.newText === "string"
      && !list.some((e) => e.oldText === params.oldText && e.newText === params.newText)) {
    list.push({ oldText: params.oldText, newText: params.newText });
  }
  return list.length ? list : null;
}

export { buildMeta };

/**
 * `edit` matches oldText as a plain substring, so an agent that never saw Kalinov's trailing tag quotes the line without it.
 * Applied as-is, the tag would be left dangling on the end of whatever the replacement ends with: the edited line loses its
 * tier and the new line inherits someone else's. Widen the edit to whole lines (tags included) so planText sees complete records.
 * Returns null when oldText is absent or ambiguous; the host then produces its own error.
 */
export function expandToLines(content: string, oldText: string, newText: string):
  { oldText: string; newText: string; start: number; end: number } | null {
  if (!oldText) return null;
  const idx = content.indexOf(oldText);
  if (idx < 0 || content.indexOf(oldText, idx + 1) >= 0) return null;
  const start = idx === 0 ? 0 : content.lastIndexOf("\n", idx - 1) + 1;
  const tail = idx + oldText.length;
  const nl = content.indexOf("\n", tail);
  const end = nl < 0 ? content.length : nl;
  return { oldText: content.slice(start, end), newText: content.slice(start, idx) + newText + content.slice(tail, end), start, end };
}

/**
 * The user asked to change a line they had already made binding ("also say: use conventional commits"), and the agent re-worded
 * the whole line. The result is the old record plus the user's new words, so it keeps the old record's tier and scope.
 * Needs the user's actual prompt: without it an agent could quietly weaken a directive, and the edit stays blocked.
 */
function amendment(text: string, removed: Array<{ text: string; meta: TierMeta }>, userText?: string): ClassifyResult | null {
  if (!userText || !removed.length || isHedged(text) || isHedged(userText)) return null;
  const user = stripEnvelope(userText);
  for (const prior of removed) {
    const fromPrior = overlap(text, prior.text).line;           // is it recognisably the same record?
    const fromBoth = overlap(text, prior.text + " " + user).line; // is every word accounted for by old record + user message?
    if (fromPrior >= 0.5 && fromBoth >= 0.7)
      return { tier: prior.meta.tier, ...(prior.meta.scope ? { scope: prior.meta.scope } : {}), reason: "user-requested amendment of an existing " + prior.meta.tier, downgraded: false, confidence: 0.8, uncertain: false };
  }
  return null;
}
