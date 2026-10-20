import { promises as fs } from "node:fs";
import path from "node:path";
import type { BeforeToolCallEvent, OpenClawPluginApi, ToolContext } from "./sdk.ts";
import { MarkdownAdapter } from "./adapters/markdown.ts";
import { buildMeta, expandToLines, normalizeEdits, planText } from "./memory-write.ts";
import { runGC } from "./gc.ts";
import { createCloudClient, localeOf, PLUGIN_VERSION, promotionAllowed, type CloudConfig, type CloudVerdict } from "./cloud.ts";
import type { EpistemicConflictError } from "./arbitration.ts";
import type { Override, WritePlan } from "./memory-write.ts";
import { formatReport, runDoctor } from "./doctor.ts";
import { memoryRootOf, patchPaths, resolveToolPath } from "./workspace.ts";
import { emptyRoutingStats, emptyOpStats, formatStats, loadRoutingStats, type OpStats, type RoutingStats } from "./stats.ts";

interface KalinovConfig { hypothesisTtlSessions?: number; strictMode?: boolean; workspaceDir?: string; guardUserFile?: boolean; cloud?: CloudConfig }
export interface KalinovState { session: number; stats?: RoutingStats }

async function loadState(root: string): Promise<KalinovState> {
  try { return JSON.parse(await fs.readFile(path.join(root, ".kalinov", "state.json"), "utf8")) as KalinovState; }
  catch { return { session: 0, stats: emptyRoutingStats() }; }
}
async function saveState(root: string, s: KalinovState): Promise<void> {
  await fs.mkdir(path.join(root, ".kalinov"), { recursive: true });
  await fs.writeFile(path.join(root, ".kalinov", "state.json"), JSON.stringify(s, null, 2));
}
async function readIfExists(p: string): Promise<string> {
  try { return await fs.readFile(p, "utf8"); }
  catch (e: any) { if (e?.code === "ENOENT") return ""; throw e; }
}

export function createKalinov(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as KalinovConfig;
  /** Shared cloud counters (network/cache/fallback). Folded into the current op's root stats at op end. */
  const cloudCounts = { network_requests: 0, cache_hits: 0, fallbacks: 0 };
  const cloud = createCloudClient(cfg.cloud, { logger: api.logger, counts: cloudCounts });
  const ttl = cfg.hypothesisTtlSessions ?? 3;
  const adapters = new Map<string, MarkdownAdapter>();
  /** runId -> the user's prompt for that run. Only populated when the host grants conversation access. */
  const prompts = new Map<string, string>();
  /** Routing stats per memory root; loaded from state.json on first touch, persisted after each gated op. */
  const stats = new Map<string, RoutingStats>();
  const rememberPrompt = (runId: string, prompt: string) => {
    prompts.set(runId, prompt);
    while (prompts.size > 64) prompts.delete(prompts.keys().next().value as string);
  };
  const adapterFor = (root: string) => {
    let a = adapters.get(root);
    if (!a) { a = new MarkdownAdapter(root); adapters.set(root, a); }
    return a;
  };
  const statsFor = async (root: string): Promise<RoutingStats> => {
    let s = stats.get(root);
    if (!s) { s = loadRoutingStats((await loadState(root)).stats); stats.set(root, s); }
    return s;
  };
  const persistStats = async (root: string, s: RoutingStats) => {
    await saveState(root, { ...(await loadState(root)), stats: s });
  };

  const resolve = (p: string, ctx: ToolContext) =>
    resolveToolPath(p, { pluginWorkspace: cfg.workspaceDir, agentId: ctx.agentId, config: api.config });

  /** apply_patch edits files with no per-line hook point. Rather than let it bypass the gate, steer the agent to write/edit. */
  function gatePatch(e: BeforeToolCallEvent, ctx: ToolContext) {
    const named = typeof e.params.input === "string" ? patchPaths(e.params.input) : [];
    const targets = [...new Set([...named, ...(e.derivedPaths ?? [])].map((p) => resolve(p, ctx)))].filter((p) => memoryRootOf(p));
    if (!targets.length) return;
    api.logger.info(`kalinov: blocked apply_patch on ${targets[0]}`);
    return {
      block: true,
      blockReason: JSON.stringify({
        error: "EpistemicGateBypass",
        attempted: { tool: "apply_patch", paths: [...new Set(targets)] },
        reason: "apply_patch cannot be tiered line-by-line, so it may not modify agent memory files.",
        resolution: "Use the write or edit tool on the memory file instead.",
      }),
    };
  }

  /**
   * Local plan first. Only lines that are uncertain AND about the same subject as an active constraint go to the cloud
   * arbitrator (at most 3 per write). Any cloud problem returns null and the local decision stands.
   * `op` receives the routing accounting: per-line events from the primary plan, cloud path selection here.
   */
  async function planWithCloud(before: string, after: string, constraints: Parameters<typeof planText>[2],
    meta: Parameters<typeof planText>[3], userText: string | undefined, file: string, op?: OpStats): Promise<WritePlan> {
    const popts: Parameters<typeof planText>[5] = { uncertainBelow: cfg.cloud?.uncertainBelow, relatedOverlap: cfg.cloud?.minRelatedOverlap,
      // Per-line accounting happens on the primary pass only; the re-plan re-classifies already-counted lines.
      observe: op ? (ev) => { op.evaluated += ev.evaluated; op.blocked += ev.blocked; op.uncertain += ev.uncertain; } : undefined };
    let plan = planText(before, after, constraints, meta, userText, popts);
    if (!plan.ok || !cloud.enabled || plan.grey.length === 0) return plan;

    const asked = plan.grey.slice(0, 3);
    if (op) { op.selected += asked.length; op.capped += plan.grey.length - asked.length; }
    const verdicts: Array<CloudVerdict | null> = await Promise.all(asked.map((g) => cloud.arbitrate({
      candidate: { text: g.line, file, tier_local: g.result.tier, confidence: g.result.confidence },
      constraints: g.related.map((c) => ({ id: c.id, tier: c.tier, text: c.content, ...(c.scope ? { scope: c.scope } : {}) })),
      ...(cfg.cloud?.sendUserTurn && userText ? { user_turn: userText } : {}),
      locale: localeOf(g.line),
      client: { plugin: PLUGIN_VERSION, host: "openclaw" },
    })));

    const overrides = new Map<string, Override>();
    for (let i = 0; i < asked.length; i++) {
      const g = asked[i], v = verdicts[i];
      if (!v || v.verdict === "allow" || !promotionAllowed(v, !!userText)) continue;
      if (v.verdict === "block") {
        const c = g.related[0];
        const conflict: EpistemicConflictError = {
          error: "EpistemicConflictError",
          source: "cloud",
          ...(v.trace_id ? { trace_id: v.trace_id } : {}),
          attempted: { tier: g.result.tier, content: g.line },
          conflicts_with: { tier: c.tier, id: c.id, content: c.content, ...(c.scope ? { scope: c.scope } : {}), recorded_at: c.recordedAt },
          reason: v.reason,
          resolution: "Ask the user, or narrow the claim to the constraint's scope.",
        };
        return { ok: false, conflict };
      }
      overrides.set(g.line, { tier: v.tier!, ...(v.scope ? { scope: v.scope } : {}), reason: `cloud: ${v.reason}`, confidence: v.confidence });
    }
    if (overrides.size) plan = planText(before, after, constraints, meta, userText, { ...popts, overrides, observe: undefined });
    return plan;
  }

  async function gate(e: BeforeToolCallEvent, ctx: ToolContext) {
    if (e.toolName === "apply_patch") return gatePatch(e, ctx);
    const rawPath = e.params.path;
    if (typeof rawPath !== "string") return;
    const abs = resolve(rawPath, ctx);
    // USER.md holds "stable preferences and profile facts as active directives" in the stock workspace template:
    // it is where an agent files "user prefers X". Opt-in: only lines with a verified user source may enter it.
    const isProfile = cfg.guardUserFile === true && path.basename(abs) === "USER.md";
    const root = isProfile ? path.dirname(abs) : memoryRootOf(abs);
    if (!root) return;
    const unverified = (plan: { stamped: Array<{ line: string; result: { tier: string } }> }) => {
      const bad = plan.stamped.find((s) => s.result.tier === "HYPOTHESIS" || s.result.tier === "OBSERVATION");
      return bad && block({
        error: "EpistemicUnverifiedDirective",
        attempted: { file: "USER.md", tier: bad.result.tier, content: bad.line },
        reason: "USER.md holds active user directives, and this line has no verified source in what the user said this turn.",
        resolution: "Ask the user to confirm it, or record it in MEMORY.md as a hypothesis.",
      });
    };

    const adapter = adapterFor(root);
    const userText = e.runId ? prompts.get(e.runId) : undefined;
    const constraints = await adapter.activeConstraints();
    const { session } = await loadState(root);
    const meta = (r: Parameters<typeof buildMeta>[0]) => buildMeta(r, session, e.runId, ttl);
    const block = (conflict: unknown) => {
      api.logger.info(`kalinov: blocked ${e.toolName} on ${rawPath}`);
      return { block: true, blockReason: JSON.stringify(conflict) };
    };

    // Routing accounting: accumulate the op in a scratch, commit to persisted stats when it finishes.
    // Reconciliation keeps the invariant evaluated = local + selected + capped + blocked by construction:
    // grey lines only leave the local bucket when the cloud path actually chose them.
    const s = await statsFor(root);
    const op = emptyOpStats();
    s.write_ops++;
    const c0 = { ...cloudCounts };
    const finish = async (blockedOp: boolean) => {
      if (blockedOp) s.write_ops_blocked++;
      s.evaluated_lines += op.evaluated;
      s.blocked_lines += op.blocked;
      s.uncertain_lines += op.uncertain;
      s.cloud_selected_lines += op.selected;
      s.cloud_capped_lines += op.capped;
      s.local_only_lines += Math.max(0, op.evaluated - op.blocked - op.selected - op.capped);
      s.cloud_network_requests += cloudCounts.network_requests - c0.network_requests;
      s.cloud_cache_hits += cloudCounts.cache_hits - c0.cache_hits;
      s.cloud_fallbacks += cloudCounts.fallbacks - c0.fallbacks;
      try {
        await persistStats(root, s);
        api.logger.info(`kalinov: routing ${formatStats(s)}`);
      } catch (err) {
        api.logger.error(`kalinov: routing stats persist failed — ${String(err)}`);
      }
    };

    if (e.toolName === "write" || e.toolName === "edit") {
      let blocked = false;
      try {
        if (e.toolName === "write") {
          if (typeof e.params.content !== "string") return;
          const plan = await planWithCloud(await readIfExists(abs), e.params.content, constraints, meta, userText, path.basename(abs), op);
          if (!plan.ok) { blocked = true; return block(plan.conflict); }
          if (isProfile) { const v = unverified(plan); if (v) { blocked = true; return v; } }
          if (cfg.strictMode && plan.stamped.some((x) => x.result.reason === "no evidence markers")) {
            blocked = true;
            return block({ error: "EpistemicUnclassifiable", resolution: "Quote the user, or cite the environment output this came from." });
          }
          return { params: { path: rawPath, content: plan.text } };
        }

        const edits = normalizeEdits(e.params);
        if (!edits) return; // malformed input: let the native tool produce its own error
        const next: Array<{ oldText: string; newText: string }> = [];
        let virtual = await readIfExists(abs); // file as it will look after the edits applied so far
        for (const ed of edits) {
          const wide = expandToLines(virtual, ed.oldText, ed.newText);
          const use = wide ?? ed;
          const plan = await planWithCloud(use.oldText, use.newText, constraints, meta, userText, path.basename(abs), op);
          if (!plan.ok) { blocked = true; return block(plan.conflict); }
          if (isProfile) { const v = unverified(plan); if (v) { blocked = true; return v; } }
          next.push({ oldText: use.oldText, newText: plan.text });
          if (wide) virtual = virtual.slice(0, wide.start) + plan.text + virtual.slice(wide.end);
        }
        return { params: { path: rawPath, edits: next } };
      } finally {
        await finish(blocked);
      }
    }
  }

  return {
    async beforeToolCall(e: BeforeToolCallEvent, ctx: ToolContext) {
      // before_tool_call fails CLOSED in the host: a throw here would block the agent's memory write.
      // Kalinov fails open instead — a bug in the gate must not cost the user their memory.
      try { return await gate(e, ctx); }
      catch (err) { api.logger.error(`kalinov: gate error, write allowed unguarded — ${String(err)}`); return; }
    },
    async sessionEnd() {
      for (const [root, adapter] of adapters) {
        try {
          const prev = await loadState(root);
          const next = { ...prev, session: prev.session + 1 };
          await saveState(root, next);
          for (const r of await runGC([adapter], next.session, new Date(), ttl, (m) => api.logger.info(`kalinov: ${m}`)))
            if (r.expired || r.contradicted) api.logger.info(`kalinov[${root}]: expired=${r.expired} contradicted=${r.contradicted}`);
        } catch (err) {
          api.logger.error(`kalinov: GC failed for ${root} — ${String(err)}`);
        }
      }
    },
    rememberPrompt,
    knownRoots: () => [...adapters.keys()],
  };
}

const plugin = {
  id: "kalinov-most",
  register(api: OpenClawPluginApi): void {
    const k = createKalinov(api);
    api.on("before_tool_call", (e, ctx) => k.beforeToolCall(e, ctx), { matcher: ["write", "edit", "apply_patch"] });
    api.on("session_end", () => k.sessionEnd());
    // Optional: verified provenance. Needs plugins.entries.kalinov-most.hooks.allowConversationAccess=true;
    // without it the host refuses this hook and Kalinov falls back to marker-based classification.
    try {
      api.on("llm_input", (e) => { if (e?.runId && typeof e.prompt === "string") k.rememberPrompt(e.runId, e.prompt); });
    } catch (err) {
      api.logger.info(`kalinov: provenance hook unavailable (${String(err)}); using marker-based classification`);
    }
    api.registerCli?.(
      ({ program, config, workspaceDir }) => {
        const root = program.command("kalinov").description("Kalinov epistemic memory gate");
        root.command("doctor").description("Check that the gate can reach and round-trip the agent's memory files")
          .option("--agent <id>", "agent whose workspace to check")
          .action(async (o: { agent?: string } = {}) => {
            const report = await runDoctor({ workspace: o.agent ? undefined : workspaceDir, config, agentId: o.agent, pluginConfig: (config as any)?.plugins?.entries?.["kalinov-most"]?.config });
            console.log(formatReport(report));
            if (!report.ok) process.exitCode = 1;
          });
      },
      { descriptors: [{ name: "kalinov", description: "Kalinov epistemic memory gate: diagnostics", hasSubcommands: true }] },
    );
  },
};

export default plugin;
