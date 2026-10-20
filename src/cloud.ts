import { createHash } from "node:crypto";
import type { Constraint, Tier } from "./adapters/types.ts";

/** Render free-tier address. Move to a custom domain before publishing; the plugin sends nothing without an API key. */
export const DEFAULT_ENDPOINT = "https://kalinov-cloud.onrender.com/v1/arbitrate";
/** An LLM judge answers in 1.3-1.7 s (measured, GLM-4.5-air); 800 ms was a placeholder that would always fail open. Only grey-zone lines pay this. */
export const DEFAULT_TIMEOUT_MS = 2500;
export const PLUGIN_VERSION = "0.1.0-pre";

export interface CloudConfig {
  apiKey?: string;
  endpoint?: string;
  /** Hard budget for one arbitration round trip. before_tool_call blocks the agent, so keep it small. */
  timeoutMs?: number;
  /** Also send the user's prompt for this turn. Off by default; needs allowConversationAccess. */
  sendUserTurn?: boolean;
  /** Local confidence below this marks a line as grey-zone. */
  uncertainBelow?: number;
  /** Minimum lexical overlap with a constraint before it is attached to a grey line. 0 (default) sends the closest constraints regardless: conflicts are often paraphrases or translations with no shared words. 0.25 restores the old privacy-first filter. */
  minRelatedOverlap?: number;
}

export interface CloudRequest {
  candidate: { text: string; file: string; tier_local: Tier; confidence: number };
  constraints: Array<{ id: string; tier: "DIRECTIVE" | "DECISION"; text: string; scope?: string }>;
  user_turn?: string;
  locale: "ru" | "en";
  client: { plugin: string; host: string };
}

export interface CloudVerdict {
  verdict: "allow" | "block" | "retier";
  tier?: Tier;
  scope?: string;
  reason: string;
  confidence: number;
  trace_id?: string;
}

const TIERS: Tier[] = ["DIRECTIVE", "DECISION", "OBSERVATION", "HYPOTHESIS"];

/** Strip secrets and contact data locally before anything leaves the machine. */
export function redact(s: string): string {
  return s
    .replace(/\b(?:sk|pk|klv|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b/g, "[secret]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [secret]")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/(?<![\w.])\+?\d[\d\s().-]{8,}\d(?![\w.])/g, "[phone]")
    .replace(/\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/g, "[secret]");
}

export const localeOf = (s: string): "ru" | "en" => (/[а-яё]/i.test(s) ? "ru" : "en");

function parseVerdict(x: unknown): CloudVerdict | null {
  if (!x || typeof x !== "object") return null;
  const v = x as Record<string, unknown>;
  if (v.verdict !== "allow" && v.verdict !== "block" && v.verdict !== "retier") return null;
  if (v.verdict === "retier" && !TIERS.includes(v.tier as Tier)) return null;
  const confidence = typeof v.confidence === "number" && v.confidence >= 0 && v.confidence <= 1 ? v.confidence : 0;
  return {
    verdict: v.verdict,
    ...(typeof v.tier === "string" && TIERS.includes(v.tier as Tier) ? { tier: v.tier as Tier } : {}),
    ...(typeof v.scope === "string" ? { scope: v.scope } : {}),
    reason: typeof v.reason === "string" ? v.reason.slice(0, 500) : "cloud arbitration",
    confidence,
    ...(typeof v.trace_id === "string" ? { trace_id: v.trace_id } : {}),
  };
}

export interface CloudClient {
  /** False without an API key. Then Kalinov makes no network requests at all. */
  readonly enabled: boolean;
  /** Resolves to a verdict, or null on ANY problem (fail-open: the caller keeps its local decision). */
  arbitrate(req: CloudRequest): Promise<CloudVerdict | null>;
}

export interface CloudDeps { logger?: { info(m: string): void }; env?: NodeJS.ProcessEnv; now?: () => number }

const BREAKER_FAILS = 3;
const BREAKER_MS = 60_000;
const CACHE_MAX = 256;
const CACHE_MS = 24 * 3600_000;

export function createCloudClient(cfg: CloudConfig | undefined, deps: CloudDeps = {}): CloudClient {
  const env = deps.env ?? process.env;
  const key = (cfg?.apiKey ?? env.KALINOV_API_KEY ?? "").trim();
  if (!key) return { enabled: false, arbitrate: async () => null };

  const endpoint = cfg?.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = Math.min(5000, Math.max(100, cfg?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const now = deps.now ?? Date.now;
  const log = (m: string) => deps.logger?.info(`kalinov-cloud: ${m}`);
  const cache = new Map<string, { at: number; v: CloudVerdict }>();
  let fails = 0;
  let openUntil = 0;

  return {
    enabled: true,
    async arbitrate(req) {
      const t = now();
      if (t < openUntil) return null; // breaker open: do not add latency to every write while the service is down

      const body = JSON.stringify({
        ...req,
        candidate: { ...req.candidate, text: redact(req.candidate.text) },
        constraints: req.constraints.map((c) => ({ ...c, text: redact(c.text) })),
        ...(req.user_turn !== undefined ? { user_turn: redact(req.user_turn) } : {}),
      });
      const ck = createHash("sha256").update(body).digest("hex");
      const hit = cache.get(ck);
      if (hit && t - hit.at < CACHE_MS) return hit.v;

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await globalThis.fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body,
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const v = parseVerdict(await res.json());
        if (!v) throw new Error("malformed verdict");
        fails = 0;
        cache.set(ck, { at: t, v });
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
        return v;
      } catch (err) {
        const why = ctl.signal.aborted ? `timeout ${timeoutMs}ms` : String((err as Error)?.message ?? err);
        if (++fails >= BREAKER_FAILS) { openUntil = t + BREAKER_MS; fails = 0; log(`unavailable (${why}); local decisions only for ${BREAKER_MS / 1000}s`); }
        else log(`skipped (${why}); using local decision`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The server can block or demote at any time. It can only PROMOTE to DIRECTIVE/DECISION when the user's own
 * prompt for this turn is available locally, so a wrong or compromised server cannot forge binding memory.
 */
export function promotionAllowed(v: CloudVerdict, haveUserTurn: boolean): boolean {
  if (v.verdict !== "retier") return true;
  return !(v.tier === "DIRECTIVE" || v.tier === "DECISION") || haveUserTurn;
}

export type { Constraint };
