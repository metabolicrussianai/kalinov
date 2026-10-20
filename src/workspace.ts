import path from "node:path";
import os from "node:os";

/**
 * Given a file path the agent is writing, return the workspace root if the path is an OpenClaw
 * memory file (<root>/MEMORY.md, <root>/memory.md, <root>/memory/<name>.md), else null.
 */
export function memoryRootOf(absPath: string): string | null {
  const base = path.basename(absPath);
  const dir = path.dirname(absPath);
  if (base === "MEMORY.md" || base === "memory.md") return dir;
  if (base.endsWith(".md") && path.basename(dir) === "memory") return path.dirname(dir);
  return null;
}

const expandHome = (p: string): string => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
const clean = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function stateDir(env: NodeJS.ProcessEnv): string {
  const s = clean(env.OPENCLAW_STATE_DIR);
  return s ? path.resolve(expandHome(s)) : path.join(os.homedir(), ".openclaw");
}

/**
 * Mirrors the host's agent workspace resolution (resolveAgentWorkspaceDir), which the
 * before_tool_call context does not expose. Verified against a live Gateway (2026.10.x):
 * relative tool paths resolve against the AGENT workspace, never the Gateway's cwd.
 *   1. agents.list[id].workspace
 *   2. default agent: agents.defaults.workspace → $OPENCLAW_WORKSPACE_DIR → <state>/workspace
 *   3. other agents:  agents.defaults.workspace/<id> → <state>/workspace-<id>
 */
export function resolveAgentWorkspace(
  agentId: string | undefined,
  openclawConfig: Record<string, any> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const agents = openclawConfig?.agents ?? {};
  const list: Array<Record<string, any>> = Array.isArray(agents.list) ? agents.list : [];
  const defaultId = String(list.find((a) => a?.default)?.id ?? list[0]?.id ?? "main").toLowerCase();
  const id = String(agentId ?? defaultId).toLowerCase();
  const configured = clean(list.find((a) => String(a?.id ?? "").toLowerCase() === id)?.workspace);
  if (configured) return path.resolve(expandHome(configured));
  const fallback = clean(agents.defaults?.workspace);
  if (id === defaultId) {
    if (fallback) return path.resolve(expandHome(fallback));
    const w = clean(env.OPENCLAW_WORKSPACE_DIR);
    if (w) return path.resolve(expandHome(w));
    return path.join(stateDir(env), "workspace");
  }
  if (fallback) return path.join(path.resolve(expandHome(fallback)), id);
  return path.join(stateDir(env), `workspace-${id}`);
}

/** Relative tool paths resolve against the plugin's `workspaceDir` override, else the calling agent's workspace. */
export function resolveToolPath(
  p: string,
  opts: { pluginWorkspace?: string; agentId?: string; config?: Record<string, any> },
): string {
  const abs = expandHome(p);
  if (path.isAbsolute(abs)) return path.normalize(abs);
  const base = opts.pluginWorkspace ? expandHome(opts.pluginWorkspace) : resolveAgentWorkspace(opts.agentId, opts.config);
  return path.resolve(base, abs);
}

/** Paths named in an apply_patch input ("*** Add/Update/Delete File: p", "*** Move to: p"). */
export function patchPaths(input: string): string[] {
  const out: string[] = [];
  for (const m of input.matchAll(/^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm)) out.push(m[1]);
  return out;
}
