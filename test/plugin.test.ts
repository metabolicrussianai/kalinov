import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin from "../src/index.ts";
import { stampLine } from "../src/adapters/markdown.ts";

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

test("registers its hooks, with a write/edit/apply_patch matcher", () => {
  const { hooks } = load();
  assert.equal(plugin.id, "kalinov-most");
  assert.deepEqual(Object.keys(hooks).sort(), ["before_tool_call", "llm_input", "session_end"], "llm_input is optional: the host only delivers it with allowConversationAccess");
  assert.deepEqual(hooks.before_tool_call.opts.matcher, ["write", "edit", "apply_patch"]);
});

test("write: decision stamped, then a generalization via edit is blocked", async () => {
  const dir = await ws();
  const { call } = load();
  const mem = path.join(dir, "MEMORY.md");
  const r1 = await call("write", { path: mem, content: "# Memory\n- User said: SQLite only for prototype A\n" });
  assert.deepEqual(Object.keys(r1.params).sort(), ["content", "path"], "must return native write schema only");
  assert.match(r1.params.content, /kalinov:\{"tier":"DECISION"/);
  await writeFile(mem, r1.params.content);

  const r2 = await call("edit", { path: mem, edits: [{ oldText: "# Memory", newText: "# Memory\n- user prefers SQLite" }] });
  assert.equal(r2.block, true);
  assert.equal(JSON.parse(r2.blockReason).error, "EpistemicConflictError");
});

test("write that rewrites the whole file never re-labels existing memory", async () => {
  const dir = await ws();
  const mem = path.join(dir, "MEMORY.md");
  await writeFile(mem, [
    "# Memory",
    "Hand-written note by the human",
    stampLine("User said: never deploy on Friday", { tier: "DIRECTIVE", recordedAt: "2026-10-01T00:00:00Z", recordedSession: 0 }),
  ].join("\n"));
  const { call } = load();
  const r = await call("write", { path: mem, content: "# Memory\nHand-written note by the human\nUser said: never deploy on Friday\nmaybe Redis later\n" });
  const lines = r.params.content.split("\n");
  assert.equal(lines[1], "Hand-written note by the human", "human line stays untagged");
  assert.match(lines[2], /"tier":"DIRECTIVE".*"recordedAt":"2026-10-01/, "existing directive keeps its original tag");
  assert.match(lines[3], /maybe Redis later <!-- kalinov:\{"tier":"HYPOTHESIS"/);
});

test("edit: legacy oldText/newText is normalized to native {path, edits}", async () => {
  const dir = await ws();
  const mem = path.join(dir, "memory", "2026-10-19.md");
  await mkdir(path.dirname(mem), { recursive: true });
  await writeFile(mem, "start\n");
  const { call } = load();
  const r = await call("edit", { path: mem, oldText: "start", newText: "start\nAPI returned status 429" });
  assert.deepEqual(Object.keys(r.params).sort(), ["edits", "path"]);
  assert.match(r.params.edits[0].newText, /status 429 <!-- kalinov:\{"tier":"OBSERVATION"/);
  assert.equal(r.params.edits[0].newText.split("\n")[0], "start", "unchanged line in newText is not stamped");
});

test("non-memory paths and malformed edits pass through untouched", async () => {
  const dir = await ws();
  const { call } = load();
  assert.equal(await call("write", { path: path.join(dir, "src", "app.ts"), content: "user prefers SQLite" }), undefined);
  assert.equal(await call("write", { path: path.join(dir, "memory", "nested", "x.md"), content: "x" }), undefined);
  assert.equal(await call("edit", { path: path.join(dir, "MEMORY.md"), edits: "not json" }), undefined);
});

test("relative paths resolve against plugin workspaceDir", async () => {
  const dir = await ws();
  const { call } = load({ workspaceDir: dir });
  const r = await call("write", { path: "MEMORY.md", content: "User said: tabs" });
  assert.equal(r.params.path, "MEMORY.md", "path is passed back exactly as the agent sent it");
  assert.match(r.params.content, /"tier":"DIRECTIVE"/);
});

test("gate errors fail open instead of blocking the memory write", async () => {
  const dir = await ws();
  await mkdir(path.join(dir, "MEMORY.md")); // a directory: reading it throws EISDIR
  const { call, logs } = load();
  assert.equal(await call("write", { path: path.join(dir, "MEMORY.md"), content: "x" }), undefined);
  assert.ok(logs.some((l) => l.startsWith("ERR kalinov: gate error")));
});

test("session_end advances the TTL clock and GC removes expired hypotheses", async () => {
  const dir = await ws();
  const mem = path.join(dir, "MEMORY.md");
  const { call, hooks } = load({ hypothesisTtlSessions: 2 });
  const r = await call("write", { path: mem, content: "maybe the user likes tabs\nUser said: never deploy on Friday\n" });
  await writeFile(mem, r.params.content);

  await hooks.session_end.h({ sessionId: "s1", messageCount: 3 }, { sessionId: "s1" });
  assert.match(await readFile(mem, "utf8"), /likes tabs/, "still alive after 1 session");
  await hooks.session_end.h({ sessionId: "s2", messageCount: 3 }, { sessionId: "s2" });
  const text = await readFile(mem, "utf8");
  assert.doesNotMatch(text, /likes tabs/, "expired after 2 sessions");
  assert.match(text, /never deploy on Friday/);
  assert.equal(JSON.parse(await readFile(path.join(dir, ".kalinov", "state.json"), "utf8")).session, 2);
});

// Regression: found on a live Gateway. Relative paths were resolved against the Gateway's cwd, so the
// gate saw an empty file and no constraints, and silently never blocked anything.
test("relative paths resolve to the calling agent's workspace (agents.list[].workspace)", async () => {
  const dir = await ws();
  const { call } = load({}, { agents: { list: [{ id: "main", default: true, workspace: dir }] } });
  const r1 = await call("write", { path: "MEMORY.md", content: "- User said: SQLite only for prototype A\n" });
  await writeFile(path.join(dir, "MEMORY.md"), r1.params.content);
  const r2 = await call("write", { path: "MEMORY.md", content: r1.params.content + "- user prefers SQLite\n" });
  assert.equal(r2.block, true);
  assert.equal(JSON.parse(r2.blockReason).error, "EpistemicConflictError");
});

test("relative paths resolve via agents.defaults.workspace, per-agent subdir for non-default agents", async () => {
  const dir = await ws();
  const cfg = { agents: { defaults: { workspace: dir }, list: [{ id: "main", default: true }, { id: "side" }] } };
  const { call } = load({}, cfg);
  await mkdir(path.join(dir, "side"), { recursive: true });
  await writeFile(path.join(dir, "side", "MEMORY.md"), stampLine("User said: use pnpm", { tier: "DIRECTIVE", recordedAt: "2026-10-01T00:00:00Z" }) + "\n");
  const r = await call("write", { path: "MEMORY.md", content: "- we never use pnpm\n" }, "side");
  assert.equal(r.block, true, "side agent sees its own workspace constraints");
  const other = await call("write", { path: "MEMORY.md", content: "- we never use pnpm\n" }, "main");
  assert.ok(other.params, "main agent has a different workspace and is not blocked");
});

test("a rewrite that drops tags restores the original tag and timestamp", async () => {
  const dir = await ws();
  const mem = path.join(dir, "MEMORY.md");
  const { call } = load();
  const r1 = await call("write", { path: mem, content: "- User said: SQLite only for prototype A\n" });
  await writeFile(mem, r1.params.content);
  const r2 = await call("write", { path: mem, content: "- User said: SQLite only for prototype A\n- Docker image is 300MB\n" });
  assert.equal(r2.params.content.split("\n")[0], r1.params.content.split("\n")[0]);
});

test("apply_patch on a memory file is blocked with a readable error; other files pass", async () => {
  const dir = await ws();
  const { call } = load({}, { agents: { list: [{ id: "main", default: true, workspace: dir }] } });
  const patch = "*** Begin Patch\n*** Update File: MEMORY.md\n@@\n-a\n+b\n*** End Patch";
  const r = await call("apply_patch", { input: patch });
  assert.equal(r.block, true);
  assert.equal(JSON.parse(r.blockReason).error, "EpistemicGateBypass");
  const viaDerived = await call("apply_patch", { input: "*** Begin Patch\n*** End Patch" }, "main", { derivedPaths: [path.join(dir, "memory", "x.md")] });
  assert.equal(viaDerived.block, true);
  assert.equal(await call("apply_patch", { input: "*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch" }), undefined);
});

test("an HTML comment inside a line does not leak into the scope", async () => {
  const dir = await ws();
  const { call } = load();
  const r = await call("write", { path: path.join(dir, "MEMORY.md"), content: "- User said: SQLite only for prototype A <!-- todo -->\n" });
  const meta = JSON.parse(/kalinov:(\{.*\})/.exec(r.params.content)![1]);
  assert.equal(meta.scope, "only for prototype A");
});

test("doctor reports a healthy workspace and a missing one", async () => {
  const { runDoctor } = await import("../src/doctor.ts");
  const dir = await ws();
  const ok = await runDoctor({ workspace: dir });
  assert.equal(ok.ok, true);
  assert.ok(ok.checks.some((c) => c.name === "round-trip" && c.ok));
  const bad = await runDoctor({ workspace: path.join(dir, "nope") });
  assert.equal(bad.ok, false);
});

test("with conversation access: the agent's plain restatement of the user's prompt is stamped DIRECTIVE, other lines stay HYPOTHESIS", async () => {
  const dir = await ws();
  const { call, hooks } = load();
  await hooks.llm_input.h({ runId: "r1", sessionId: "s1", prompt: "Save to your memory: never deploy on Fridays." }, {});
  const r = await call("write", { path: path.join(dir, "MEMORY.md"), content: "- Never deploy on Fridays.\n- The CI box is probably underpowered.\n" });
  const [a, b] = r.params.content.split("\n");
  assert.match(a, /"tier":"DIRECTIVE"/);
  assert.match(b, /"tier":"HYPOTHESIS"/);
});

test("without conversation access: the same restatement is a HYPOTHESIS (markers are the only evidence)", async () => {
  const dir = await ws();
  const { call } = load();
  const r = await call("write", { path: path.join(dir, "MEMORY.md"), content: "- Never deploy on Fridays.\n" });
  assert.match(r.params.content, /"tier":"HYPOTHESIS"/);
});

test("comment-only lines the agent writes are not stamped as memory", async () => {
  const dir = await ws();
  const { call } = load();
  const r = await call("write", { path: path.join(dir, "MEMORY.md"), content: "<!-- observed: today -->\n- Docker image is 300MB\n" });
  assert.equal(r.params.content.split("\n")[0], "<!-- observed: today -->");
});

// Regression (live, GLM): the model quotes oldText without the trailing tag and replaces the end of a stamped line.
test("edit with a tag-less, mid-line oldText keeps the old line's tag and stamps the new line once", async () => {
  const dir = await ws();
  const mem = path.join(dir, "MEMORY.md");
  const { call } = load();
  const r1 = await call("write", { path: mem, content: "- User said: SQLite only for prototype A, then Postgres.\n" });
  await writeFile(mem, r1.params.content);
  const r2 = await call("edit", { path: mem, edits: [{ oldText: "then Postgres.", newText: "then Postgres.\n- Docker image is 300MB" }] });
  const e = r2.params.edits[0];
  assert.ok(e.oldText.includes("kalinov:"), "edit widened to the whole stamped line");
  const after = r1.params.content.replace(e.oldText, e.newText);
  const lines = after.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /"tier":"DECISION"/);
  assert.match(lines[1], /"tier":"HYPOTHESIS"/);
  assert.equal((after.match(/kalinov:/g) ?? []).length, 2, "exactly one tag per line");
});

test("guardUserFile: an inferred preference is refused in USER.md, the user's own words are stamped; off by default", async () => {
  const dir = await ws();
  const f = path.join(dir, "USER.md");
  const off = load();
  assert.equal(await off.call("write", { path: f, content: "- User prefers SQLite.\n" }), undefined, "USER.md untouched when the option is off");
  const { call, hooks } = load({ guardUserFile: true });
  await hooks.llm_input.h({ runId: "r1", sessionId: "s1", prompt: "Remember I prefer tabs over spaces." }, {});
  const ok = await call("write", { path: f, content: "- Prefers tabs over spaces.\n" });
  assert.match(ok.params.content, /"tier":"DIRECTIVE"/);
  const bad = await call("write", { path: f, content: "- Prefers tabs over spaces.\n- Prefers SQLite everywhere.\n" });
  assert.equal(bad.block, true);
  assert.equal(JSON.parse(bad.blockReason).error, "EpistemicUnverifiedDirective");
});

// Regression (live, GLM): "Update that line to also say ..." produced a re-worded HYPOTHESIS that was blocked as overriding a DIRECTIVE.
test("a user-requested amendment of a DIRECTIVE keeps its tier instead of being blocked as a lower-tier override", async () => {
  const dir = await ws();
  const mem = path.join(dir, "MEMORY.md");
  const { call, hooks } = load();
  await hooks.llm_input.h({ runId: "r1", sessionId: "s1", prompt: "Save to MEMORY.md: always write commit messages in English." }, {});
  const r1 = await call("write", { path: mem, content: "- Always write commit messages in English.\n" });
  assert.match(r1.params.content, /"tier":"DIRECTIVE"/);
  await writeFile(mem, r1.params.content);
  await hooks.llm_input.h({ runId: "r2", sessionId: "s1", prompt: "Update that line in MEMORY.md to also say: use conventional commits." }, {});
  const ok = await call("write", { path: mem, content: "- Always write commit messages in English using conventional commits format.\n" }, "main", { runId: "r2" });
  assert.equal(ok.block, undefined);
  assert.match(ok.params.content, /"tier":"DIRECTIVE"/);
});
