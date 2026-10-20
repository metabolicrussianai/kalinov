import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin from "../src/index.ts";
import { stampLine } from "../src/adapters/markdown.ts";
import { emptyRoutingStats, loadRoutingStats, cloudRoutingShare } from "../src/stats.ts";

const realFetch = globalThis.fetch;
function stubFetch(impl: () => Promise<Response>) {
  globalThis.fetch = (async () => impl()) as any;
}
const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } }));

function load(pluginConfig: Record<string, unknown> = {}, hostConfig: Record<string, any> = {}) {
  const hooks: Record<string, { h: Function; opts?: any }> = {};
  const logs: string[] = [];
  const api: any = {
    id: "kalinov-most", config: hostConfig, pluginConfig,
    logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push("ERR " + m) },
    on: (name: string, h: Function, opts?: any) => { hooks[name] = { h, opts }; },
  };
  plugin.register(api);
  const call = (toolName: string, params: Record<string, unknown>, agentId = "main", extra: Record<string, unknown> = {}) =>
    hooks.before_tool_call.h({ toolName, params, toolCallId: "c1", runId: "r1", ...extra }, { toolName, agentId, sessionKey: `agent:${agentId}:s1` });
  return { hooks, logs, call };
}
const ws = () => mkdtemp(path.join(tmpdir(), "kalinov-"));
const readStats = async (dir: string) => JSON.parse(await readFile(path.join(dir, ".kalinov", "state.json"), "utf8")).stats;

test("stats module: empty, load tolerates junk, share is null without lines", () => {
  const s = emptyRoutingStats();
  assert.equal(s.evaluated_lines, 0);
  assert.equal(cloudRoutingShare(s), null);
  assert.deepEqual(loadRoutingStats(undefined), emptyRoutingStats(), "missing stats field on old state files");
  const j = loadRoutingStats({ evaluated_lines: 3, local_only_lines: "junk", since: "2026-10-20T00:00:00Z" });
  assert.equal(j.evaluated_lines, 3);
  assert.equal(j.local_only_lines, 0, "non-numeric fields are ignored");
  assert.equal(j.since, "2026-10-20T00:00:00Z");
});

test("routing counters: local-only lines counted, invariant holds, stats persisted and logged", async () => {
  const dir = await ws();
  const { call, logs } = load({}, { agents: { list: [{ id: "main", default: true, workspace: dir }] } });
  const mem = path.join(dir, "MEMORY.md");
  // two confident lines (quoted user words + env observation), no constraints yet -> all local
  const r = await call("write", { path: mem, content: "- User said: SQLite only for prototype A\n- Env output: image 300MB\n" });
  await writeFile(mem, r.params.content);
  const s1 = await readStats(dir);
  assert.equal(s1.write_ops, 1);
  assert.equal(s1.evaluated_lines, 2);
  assert.equal(s1.local_only_lines, 2);
  assert.equal(s1.cloud_selected_lines, 0);
  assert.ok(logs.some((l) => l.startsWith("kalinov: routing") && l.includes("evaluated=2")), "structured routing log line per op");
  // invariant: evaluated = local + cloud_selected + capped + blocked
  assert.equal(s1.evaluated_lines, s1.local_only_lines + s1.cloud_selected_lines + s1.cloud_capped_lines + s1.blocked_lines);
});

test("routing counters survive a host restart (state.json reload)", async () => {
  const dir = await ws();
  const cfg = { agents: { list: [{ id: "main", default: true, workspace: dir }] } };
  const first = load({}, cfg);
  const mem = path.join(dir, "MEMORY.md");
  const r = await first.call("write", { path: mem, content: "- User said: SQLite only for prototype A\n" });
  await writeFile(mem, r.params.content);
  const before = await readStats(dir);

  const second = load({}, cfg); // fresh plugin instance, same workspace on disk
  const r2 = await second.call("write", { path: mem, content: r.params.content + "- Env output: build green\n" });
  await writeFile(mem, r2.params.content);
  const after = await readStats(dir);
  assert.equal(after.write_ops, before.write_ops + 1, "counters continue from the persisted values");
  assert.equal(after.evaluated_lines, before.evaluated_lines + 1);
  assert.equal(after.since, before.since, "since stays at first collection start");
});

test("uncertain line with an active constraint routes to the cloud; cache-served verdicts still count as routed", async () => {
  const dir = await ws();
  const { call } = load({
    cloud: { endpoint: "http://judge.test", apiKey: "k", timeoutMs: 10 },
  }, { agents: { list: [{ id: "main", default: true, workspace: dir }] } });
  try {
  const mem = path.join(dir, "MEMORY.md");
  const now = new Date().toISOString();
  const c = stampLine("User said: SQLite only for prototype A", { tier: "DECISION", recordedAt: now, recordedSession: 0 });
  await writeFile(mem, `# Memory\n${c}\n`);
  // "The SQLite file lives in the data folder" is a plain factual line: no markers -> uncertain, shares the subject -> grey -> cloud path chosen
  const r = await call("write", { path: mem, content: `# Memory\n${c}\n- The SQLite file lives in the data folder\n` });
  await writeFile(mem, r.params.content);
  const s = await readStats(dir);
  assert.equal(s.evaluated_lines, 1);
  assert.equal(s.cloud_selected_lines, 1);
  assert.equal(s.cloud_network_requests, 1);
  assert.equal(s.cloud_cache_hits, 0);
  assert.equal(s.local_only_lines, 0, "the grey line is neither local-only nor blocked");
  } finally { globalThis.fetch = realFetch; }

  // client level: the same request twice -> one network call, one cache hit; routing was still chosen both times
  const counts = { network_requests: 0, cache_hits: 0, fallbacks: 0 };
  let net = 0;
  stubFetch(async () => { net++; return json({ verdict: "allow", reason: "ok", confidence: 0.9 }); });
  const { createCloudClient } = await import("../src/cloud.ts");
  try {
    const client = createCloudClient({ endpoint: "http://judge.test", apiKey: "k", timeoutMs: 10 }, { counts });
    const REQ = { candidate: { text: "maybe Redis for prototype A", file: "MEMORY.md", tier_local: "HYPOTHESIS", confidence: 0.5 },
      constraints: [{ id: "MEMORY.md#L2", tier: "DECISION", text: "SQLite only for prototype A", scope: "only for prototype A" }] };
    await client.arbitrate(REQ as any);
    await client.arbitrate(REQ as any);
    assert.equal(net, 1, "second identical ask is served from cache");
    assert.equal(counts.cache_hits, 1);
    assert.equal(counts.network_requests, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("cloud failure is a fallback, not an unrouted line; the local decision stands", async () => {
  const dir = await ws();
  stubFetch(async () => new Response("boom", { status: 500 }));
  const { call } = load({ cloud: { endpoint: "http://judge.test", apiKey: "k", timeoutMs: 10 } },
    { agents: { list: [{ id: "main", default: true, workspace: dir }] } });
  try {
  const mem = path.join(dir, "MEMORY.md");
  const now = new Date().toISOString();
  const c = stampLine("User said: SQLite only for prototype A", { tier: "DECISION", recordedAt: now, recordedSession: 0 });
  await writeFile(mem, `# Memory\n${c}\n`);
  const r = await call("write", { path: mem, content: `# Memory\n${c}\n- The SQLite file lives in the data folder\n` });
  assert.ok(r.params, "fail-open: the write passes on a local decision");
  const s = await readStats(dir);
  assert.equal(s.cloud_selected_lines, 1, "the routing choice is not undone by the failure");
  assert.equal(s.cloud_fallbacks, 1);
  assert.equal(s.cloud_network_requests, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("an early block stops evaluation: later lines are not counted anywhere", async () => {
  const dir = await ws();
  const { call } = load({}, { agents: { list: [{ id: "main", default: true, workspace: dir }] } });
  const mem = path.join(dir, "MEMORY.md");
  const now = new Date().toISOString();
  const directive = stampLine("User said: never deploy on Friday", { tier: "DIRECTIVE", recordedAt: now, recordedSession: 0 });
  await writeFile(mem, `# Memory\n${directive}\n`);
  // the generalization line conflicts -> block; the trailing line after it is never classified
  const r = await call("write", { path: mem, content: `# Memory\n${directive}\n- we never deploy on Friday\n- Env output: build green\n` });
  assert.equal(r.block, true);
  const s = await readStats(dir);
  assert.equal(s.write_ops, 1);
  assert.equal(s.write_ops_blocked, 1);
  assert.equal(s.blocked_lines, 1);
  assert.equal(s.evaluated_lines, 1);
  assert.equal(s.blocked_lines, 1);
  assert.equal(s.local_only_lines, 0, "the conflicting line is blocked; the last line was never classified");
});

test("grey lines beyond the per-write cap count as capped, not selected", async () => {
  const dir = await ws();
  stubFetch(async () => json({ verdicts: [] }));
  const { call } = load({ cloud: { endpoint: "http://judge.test", apiKey: "k", timeoutMs: 10 } },
    { agents: { list: [{ id: "main", default: true, workspace: dir }] } });
  try {
  const mem = path.join(dir, "MEMORY.md");
  const now = new Date().toISOString();
  const c = stampLine("User said: SQLite only for prototype A", { tier: "DECISION", recordedAt: now, recordedSession: 0 });
  await writeFile(mem, `# Memory\n${c}\n`);
  // four uncertain factual lines on the same subject: only 3 are asked, the 4th is capped out
  const r = await call("write", { path: mem, content: `# Memory\n${c}\n- The SQLite file lives in the data folder\n- The SQLite database grows by 2MB a day\n- The SQLite file is backed up nightly\n- The SQLite file sits next to the config\n` });
  const s = await readStats(dir);
  assert.equal(s.evaluated_lines, 4);
  assert.equal(s.cloud_selected_lines, 3);
  assert.equal(s.cloud_capped_lines, 1);
  assert.equal(s.uncertain_lines, 4);
  assert.equal(s.local_only_lines, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("doctor prints the routing stats block", async () => {
  const { runDoctor, formatReport } = await import("../src/doctor.ts");
  const dir = await ws();
  const mem = path.join(dir, "MEMORY.md");
  const { call } = load({}, { agents: { list: [{ id: "main", default: true, workspace: dir }] } });
  const r = await call("write", { path: mem, content: "- User said: SQLite only for prototype A\n" });
  await writeFile(mem, r.params.content);
  const rep = await runDoctor({ workspace: dir });
  const check = rep.checks.find((c) => c.name === "routing stats")!;
  assert.ok(check.detail.includes("evaluated=1"));
  assert.ok(check.detail.includes("cloud routing share=0.0%"));
  assert.ok(formatReport(rep).includes("routing stats"));
});

test("non-memory writes are not counted; apply_patch bypass attempts are not write ops", async () => {
  const dir = await ws();
  const { call } = load({}, { agents: { list: [{ id: "main", default: true, workspace: dir }] } });
  await mkdir(path.join(dir, "memory"), { recursive: true });
  await call("write", { path: path.join(dir, "src", "app.ts"), content: "console.log(1)" });
  const noState = await readFile(path.join(dir, ".kalinov", "state.json"), "utf8").then(() => false, () => true);
  assert.ok(noState, "a non-memory write creates no state and no stats");
  const patch = "*** Begin Patch\n*** Update File: memory/x.md\n@@\n-a\n+b\n*** End Patch";
  await call("apply_patch", { input: patch });
  const stillNoState = await readFile(path.join(dir, ".kalinov", "state.json"), "utf8").then(() => false, () => true);
  assert.ok(stillNoState, "apply_patch bypass attempts are not write ops");
});
