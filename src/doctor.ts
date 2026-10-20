import { promises as fs } from "node:fs";
import path from "node:path";
import { MarkdownAdapter } from "./adapters/markdown.ts";
import { resolveAgentWorkspace } from "./workspace.ts";

export interface DoctorReport { ok: boolean; workspace: string; checks: Array<{ name: string; ok: boolean; detail: string }> }

/**
 * `openclaw kalinov doctor`: proves the storage path works (write/list/delete round-trip) and reports what the
 * gate will see. Does not touch existing memory lines.
 */
export async function runDoctor(opts: { workspace?: string; config?: Record<string, any>; agentId?: string; pluginConfig?: Record<string, any> }): Promise<DoctorReport> {
  const workspace = opts.workspace ?? opts.pluginConfig?.workspaceDir ?? resolveAgentWorkspace(opts.agentId, opts.config);
  const checks: DoctorReport["checks"] = [];

  let dirOk = false;
  try { dirOk = (await fs.stat(workspace)).isDirectory(); } catch { /* missing */ }
  checks.push({ name: "workspace", ok: dirOk, detail: dirOk ? workspace : `${workspace} does not exist (the agent has not run yet, or workspaceDir is wrong)` });
  if (!dirOk) return { ok: false, workspace, checks };

  const adapter = new MarkdownAdapter(workspace);
  const rt = await adapter.doctor();
  checks.push({ name: "round-trip", ok: rt.ok, detail: rt.detail });

  const constraints = await adapter.activeConstraints();
  const tiers: Record<string, number> = {};
  for (const r of await adapter.list({})) tiers[r.meta.tier] = (tiers[r.meta.tier] ?? 0) + 1;
  checks.push({ name: "stamped records", ok: true, detail: Object.keys(tiers).length ? JSON.stringify(tiers) : "none yet" });
  checks.push({ name: "active constraints", ok: true, detail: String(constraints.length) });

  let session = 0;
  try { session = JSON.parse(await fs.readFile(path.join(workspace, ".kalinov", "state.json"), "utf8")).session; } catch { /* first run */ }
  checks.push({ name: "session counter", ok: true, detail: String(session) });

  const ttl = opts.pluginConfig?.hypothesisTtlSessions ?? 3;
  checks.push({ name: "hypothesis TTL", ok: Number.isInteger(ttl) && ttl >= 1, detail: `${ttl} sessions` });

  return { ok: checks.every((c) => c.ok), workspace, checks };
}

export function formatReport(r: DoctorReport): string {
  return [`kalinov doctor — ${r.ok ? "OK" : "PROBLEMS FOUND"}`, ...r.checks.map((c) => `  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`)].join("\n");
}
