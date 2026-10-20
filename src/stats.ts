/**
 * Routing statistics: what share of classified memory lines the gate routes to the cloud judge.
 *
 * Counters are stored per memory root in `.kalinov/state.json` next to the session counter, so they
 * survive host restarts. Only numbers are kept — no line texts, no prompts, no file paths.
 *
 * The headline metric is `cloud_selected_lines / evaluated_lines`:
 * the share of newly written lines for which the cloud path was actually chosen (grey-zone lines,
 * related to an active constraint, within the per-write cap, with cloud configured).
 *
 * Definitions (a line is counted once, at classification time):
 * - `evaluated_lines`  — new content lines that reached classification. Lines after an early block
 *   were never classified and are not counted. Unchanged pre-existing lines are never re-evaluated.
 * - `local_only_lines` — classified and decided locally (confident, or uncertain with no cloud path chosen).
 * - `uncertain_lines`  — informational: lines classified below the confidence threshold, regardless of
 *   whether a cloud path existed (no constraints in memory, cloud disabled, or over the per-write cap).
 * - `cloud_selected_lines` — grey-zone lines for which the cloud path was chosen (asked of the judge).
 * - `cloud_capped_lines`   — grey-zone lines beyond the per-write cap: the cloud path was available but not taken.
 * - `blocked_lines`   — classified lines whose write was rejected by a conflict. A blocked line is evaluated,
 *   but neither local-only nor cloud-selected; the remaining lines of that write were not evaluated.
 * - `cloud_network_requests` — HTTP requests actually initiated (cache hits excluded).
 * - `cloud_cache_hits`       — verdicts served from the 24h cache (still routed: the cloud path was chosen).
 * - `cloud_fallbacks`        — asked of the judge but no verdict came back (timeout, HTTP error, breaker);
 *   the local decision stood. Does not undo the routing choice.
 *
 * Invariant: `evaluated_lines = local_only_lines + cloud_selected_lines + cloud_capped_lines + blocked_lines`.
 */
export interface RoutingStats {
  /** ISO timestamp of when this stats object first started accumulating. */
  since: string;
  write_ops: number;
  write_ops_blocked: number;
  evaluated_lines: number;
  local_only_lines: number;
  uncertain_lines: number;
  cloud_selected_lines: number;
  cloud_capped_lines: number;
  cloud_network_requests: number;
  cloud_cache_hits: number;
  cloud_fallbacks: number;
  blocked_lines: number;
}

/** Per-line events emitted while planning a write. `planText` reports them as lines are classified. */
export interface PlanObserve {
  /** A new content line reached classification. */
  evaluated: number;
  /** The classified line was rejected by a conflict; lines after it in this write are not evaluated. */
  blocked: number;
  /** Informational: the line was classified below the confidence threshold. */
  uncertain: number;
}

/** Per-write-op scratch, committed to the persisted stats only when the op finishes. */
export interface OpStats {
  evaluated: number;
  blocked: number;
  uncertain: number;
  selected: number;
  capped: number;
}

export const emptyOpStats = (): OpStats => ({ evaluated: 0, blocked: 0, uncertain: 0, selected: 0, capped: 0 });

export function emptyRoutingStats(now: () => Date = () => new Date()): RoutingStats {
  return {
    since: now().toISOString(),
    write_ops: 0,
    write_ops_blocked: 0,
    evaluated_lines: 0,
    local_only_lines: 0,
    uncertain_lines: 0,
    cloud_selected_lines: 0,
    cloud_capped_lines: 0,
    cloud_network_requests: 0,
    cloud_cache_hits: 0,
    cloud_fallbacks: 0,
    blocked_lines: 0,
  };
}

/** Merge persisted stats into a fresh object, tolerating older state files without a `stats` field. */
export function loadRoutingStats(raw: unknown, now: () => Date = () => new Date()): RoutingStats {
  const s = emptyRoutingStats(now);
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Partial<RoutingStats>;
  for (const k of Object.keys(s) as Array<keyof RoutingStats>) {
    if (typeof r[k] === "number" && Number.isFinite(r[k])) (s as unknown as Record<string, number | string>)[k] = r[k];
  }
  if (typeof r.since === "string" && !Number.isNaN(Date.parse(r.since))) s.since = r.since;
  return s;
}

/** The headline number: share of evaluated lines for which the cloud path was chosen. */
export function cloudRoutingShare(s: RoutingStats): number | null {
  return s.evaluated_lines === 0 ? null : s.cloud_selected_lines / s.evaluated_lines;
}

export function formatStats(s: RoutingStats): string {
  const share = cloudRoutingShare(s);
  return [
    `evaluated=${s.evaluated_lines} local=${s.local_only_lines} cloud=${s.cloud_selected_lines}`,
    `capped=${s.cloud_capped_lines} blocked=${s.blocked_lines}`,
    `net=${s.cloud_network_requests} cache=${s.cloud_cache_hits} fallback=${s.cloud_fallbacks}`,
    `ops=${s.write_ops} (blocked ops: ${s.write_ops_blocked})`,
    `cloud routing share=${share === null ? "n/a (no lines yet)" : `${(share * 100).toFixed(1)}%`}`,
  ].join(" ");
}
