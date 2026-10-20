import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin from "../src/index.ts";
import { stampLine } from "../src/adapters/markdown.ts";
import { createCloudClient, promotionAllowed, redact, type CloudRequest } from "../src/cloud.ts";
import { classify, UNCERTAIN_BELOW } from "../src/classifier.ts";

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: any; body: any }> = [];
function stubFetch(impl: (url: string, init: any) => Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return impl(String(url), init);
  }) as any;
}
const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } }));
const hang = (_u: string, init: any) => new Promise<Response>((_res, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

const REQ: CloudRequest = {
  candidate: { text: "The SQLite file lives in the data folder", file: "MEMORY.md", tier_local: "HYPOTHESIS", confidence: 0.5 },
  constraints: [{ id: "MEMORY.md#L1", tier: "DECISION", text: "SQLite only for prototype A", scope: "only for prototype A" }],
  locale: "en", client: { plugin: "t", host: "t" },
};
const ALLOW = { verdict: "allow", reason: "ok", confidence: 0.9 };

// ---------- classifier scale
test("classifier exposes a confidence scale; neutral and generalizing lines are uncertain, quoted ones are not", () => {
  assert.equal(classify({ content: "User said: use pnpm" }).uncertain, false);
  assert.equal(classify({ content: "The SQLite file lives in the data folder" }).uncertain, true);
  assert.equal(classify({ content: "We always use SQLite everywhere" }).uncertain, true, "an unevidenced generalization is a guess, not a verdict");
  assert.ok(classify({ content: "The SQLite file lives in the data folder" }).confidence < UNCERTAIN_BELOW);
  assert.equal(classify({ content: "The cache is probably slow" }).uncertain, false, "an explicit hedge is a confident HYPOTHESIS");
  assert.equal(classify({ content: "Never deploy on Fridays.", userText: "Save: never deploy on Fridays." }).uncertain, false);
});

// ---------- client: privacy and fail-open
test("without an API key the client is disabled and makes no network request", async () => {
  stubFetch(() => { throw new Error("network touched"); });
  const c = createCloudClient({}, { env: {} });
  assert.equal(c.enabled, false);
  assert.equal(await c.arbitrate(REQ), null);
  assert.equal(calls.length, 0);
});

test("the key can come from KALINOV_API_KEY; it is sent as a bearer token to the configured endpoint", async () => {
  stubFetch(() => json(ALLOW));
  const c = createCloudClient({ endpoint: "https://kalinov.test/v1/arbitrate" }, { env: { KALINOV_API_KEY: "klv_live_secretsecretsecret" } });
  assert.equal(c.enabled, true);
  await c.arbitrate(REQ);
  assert.equal(calls[0].url, "https://kalinov.test/v1/arbitrate");
  assert.equal(calls[0].init.headers.authorization, "Bearer klv_live_secretsecretsecret");
});

test("secrets, e-mails and phone numbers are redacted before anything is sent", async () => {
  stubFetch(() => json(ALLOW));
  const c = createCloudClient({ apiKey: "k1" });
  await c.arbitrate({ ...REQ, candidate: { ...REQ.candidate, text: "token sk-abcdef1234567890XYZ mail me@corp.com call +7 (910) 123-45-67 Bearer abcdefghijklmnop1234" } });
  const sent = JSON.stringify(calls[0].body);
  for (const leak of ["sk-abcdef", "me@corp.com", "123-45-67", "abcdefghijklmnop1234"]) assert.ok(!sent.includes(leak), leak);
  assert.match(sent, /\[secret\]/); assert.match(sent, /\[email\]/); assert.match(sent, /\[phone\]/);
  assert.equal(redact("plain sentence about SQLite"), "plain sentence about SQLite");
});

test("timeout: a hung server costs at most ~timeoutMs and yields null", async () => {
  stubFetch(hang);
  const c = createCloudClient({ apiKey: "k", timeoutMs: 100 });
  const t0 = Date.now();
  assert.equal(await c.arbitrate(REQ), null);
  assert.ok(Date.now() - t0 < 600, `took ${Date.now() - t0}ms`);
});

test("HTTP errors, malformed JSON, unknown verdicts and network errors all fail open to null", async () => {
  const c = createCloudClient({ apiKey: "k" });
  for (const impl of [
    () => json({}, 500), () => json({}, 401), () => json({}, 429),
    () => Promise.resolve(new Response("not json", { status: 200 })),
    () => json({ verdict: "delete-everything" }),
    () => json({ verdict: "retier", tier: "GOD_MODE", reason: "x", confidence: 1 }),
    () => Promise.reject(new TypeError("fetch failed")),
  ]) {
    stubFetch(impl as any);
    assert.equal(await createCloudClient({ apiKey: "k" }).arbitrate(REQ), null);
  }
  void c;
});

test("circuit breaker: after 3 consecutive failures the client stops calling the network for a minute", async () => {
  let t = 1_000_000;
  stubFetch(() => json({}, 503));
  const c = createCloudClient({ apiKey: "k" }, { now: () => t });
  for (let i = 0; i < 3; i++) { t += 10; await c.arbitrate({ ...REQ, candidate: { ...REQ.candidate, text: "x" + i } }); }
  assert.equal(calls.length, 3);
  await c.arbitrate(REQ);
  assert.equal(calls.length, 3, "breaker open: no request");
  t += 61_000;
  stubFetch(() => json(ALLOW));
  assert.ok(await c.arbitrate(REQ), "closes after the cool-down");
});

test("identical requests are served from the cache", async () => {
  stubFetch(() => json(ALLOW));
  const c = createCloudClient({ apiKey: "k" });
  await c.arbitrate(REQ); await c.arbitrate(REQ);
  assert.equal(calls.length, 1);
});

test("a cloud verdict may promote to DIRECTIVE/DECISION only when the user's own prompt is available locally", () => {
  const promote = { verdict: "retier", tier: "DIRECTIVE", reason: "r", confidence: 1 } as const;
  assert.equal(promotionAllowed(promote, false), false);
  assert.equal(promotionAllowed(promote, true), true);
  assert.equal(promotionAllowed({ verdict: "retier", tier: "HYPOTHESIS", reason: "r", confidence: 1 }, false), true, "demotion is always fine");
  assert.equal(promotionAllowed({ verdict: "block", reason: "r", confidence: 1 }, false), true);
});

// ---------- plugin integration
function load(pluginConfig: Record<string, unknown>) {
  const hooks: Record<string, { h: Function }> = {};
  const logs: string[] = [];
  const api: any = {
    id: "kalinov-most", config: {}, pluginConfig,
    logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push("ERR " + m) },
    on: (n: string, h: Function) => { hooks[n] = { h }; },
  };
  plugin.register(api);
  const call = (content: string, file: string, runId = "r1") =>
    hooks.before_tool_call.h({ toolName: "write", params: { path: file, content }, toolCallId: "c", runId }, { toolName: "write", agentId: "main", sessionKey: "agent:main:s" });
  return { hooks, logs, call };
}
async function seeded() {
  const dir = await mkdtemp(path.join(tmpdir(), "kalinov-cloud-"));
  const f = path.join(dir, "MEMORY.md");
  const decision = stampLine("- User said: SQLite only for prototype A", { tier: "DECISION", recordedAt: "2026-10-01T00:00:00Z", scope: "only for prototype A" });
  await writeFile(f, decision + "\n");
  return { f, decision };
}
const GREY = "The SQLite file lives in the data folder";
const CFG = { cloud: { apiKey: "k", endpoint: "https://kalinov.test/a", timeoutMs: 150 } };

test("cloud is asked about uncertain lines when constraints exist, closest constraints first; confident lines and constraint-free files stay local", async () => {
  stubFetch(() => json(ALLOW));
  const { f, decision } = await seeded();
  const { call } = load(CFG);
  await call(`${decision}\n- User said: use pnpm\n`, f);       // explicit quote: confident, never leaves the machine
  assert.equal(calls.length, 0);
  await call(`${decision}\n- ${GREY}\n`, f);                   // uncertain, shares a word
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.candidate.text, GREY);
  assert.equal(calls[0].body.constraints[0].id, "MEMORY.md#L1");
  assert.equal(calls[0].body.user_turn, undefined, "user turn is not sent unless sendUserTurn is on");
  await call(`${decision}\n- Customer backups are stored in Virginia\n`, f); // shares no word with the constraint: a paraphrase-class conflict must still reach the judge
  assert.equal(calls.length, 2);
});

test("minRelatedOverlap restores the privacy-first filter: lines with no lexical link to a constraint stay local", async () => {
  stubFetch(() => json(ALLOW));
  const { f, decision } = await seeded();
  const { call } = load({ cloud: { ...CFG.cloud, minRelatedOverlap: 0.25 } });
  await call(`${decision}\n- Customer backups are stored in Virginia\n`, f);
  assert.equal(calls.length, 0);
  await call(`${decision}\n- ${GREY}\n`, f);
  assert.equal(calls.length, 1);
});

test("at most 8 constraints are attached to a line, closest first", async () => {
  stubFetch(() => json(ALLOW));
  const dir = await mkdtemp(path.join(tmpdir(), "kalinov-cloud-"));
  const f = path.join(dir, "MEMORY.md");
  const rules = Array.from({ length: 12 }, (_, i) => stampLine(`- User said: rule ${i} about zebra${i}`, { tier: "DIRECTIVE", recordedAt: "2026-10-01T00:00:00Z" }));
  rules.push(stampLine("- User said: SQLite only for prototype A", { tier: "DECISION", recordedAt: "2026-10-01T00:00:00Z", scope: "only for prototype A" }));
  await writeFile(f, rules.join("\n") + "\n");
  await load(CFG).call(`${rules.join("\n")}\n- ${GREY}\n`, f);
  assert.equal(calls[0].body.constraints.length, 8);
  assert.ok(calls[0].body.constraints.some((c: any) => /SQLite/.test(c.text)), "the closest constraint is among them");
});

test("a cloud 'block' verdict blocks the write and says who decided", async () => {
  stubFetch(() => json({ verdict: "block", reason: "Implies SQLite is the system of record, contradicting the prototype-only decision.", confidence: 0.91, trace_id: "tr_1" }));
  const { f, decision } = await seeded();
  const r = await load(CFG).call(`${decision}\n- ${GREY}\n`, f);
  assert.equal(r.block, true);
  const err = JSON.parse(r.blockReason);
  assert.equal(err.error, "EpistemicConflictError");
  assert.equal(err.source, "cloud");
  assert.equal(err.trace_id, "tr_1");
  assert.equal(err.conflicts_with.id, "MEMORY.md#L1");
});

test("a cloud 'retier' demotion is applied; a promotion without the user's prompt is ignored, with it is honored", async () => {
  const { f, decision } = await seeded();
  stubFetch(() => json({ verdict: "retier", tier: "OBSERVATION", reason: "environment fact", confidence: 0.9 }));
  const demoted = await load(CFG).call(`${decision}\n- ${GREY}\n`, f);
  assert.match(demoted.params.content, /"tier":"OBSERVATION"/);

  stubFetch(() => json({ verdict: "retier", tier: "DIRECTIVE", reason: "user rule", confidence: 0.99 }));
  const noPrompt = await load(CFG).call(`${decision}\n- ${GREY}\n`, f);
  assert.match(noPrompt.params.content, /"tier":"HYPOTHESIS"/, "server cannot forge a directive without the user's words");

  const withPrompt = load(CFG);
  await withPrompt.hooks.llm_input.h({ runId: "r9", sessionId: "s", prompt: "unrelated chatter" }, {});
  const promoted = await withPrompt.call(`${decision}\n- ${GREY}\n`, f, "r9");
  assert.match(promoted.params.content, /"tier":"DIRECTIVE"/);
});

test("fail-open end to end: timeout, 500 and garbage leave the local decision (stamped HYPOTHESIS, not blocked)", async () => {
  const { f, decision } = await seeded();
  for (const impl of [hang as any, () => json({}, 500), () => Promise.resolve(new Response("<html>", { status: 200 }))]) {
    stubFetch(impl);
    const r = await load(CFG).call(`${decision}\n- ${GREY}\n`, f);
    assert.equal(r.block, undefined);
    assert.match(r.params.content, /"tier":"HYPOTHESIS"/);
  }
});

test("with no key configured the grey-zone line never touches the network", async () => {
  stubFetch(() => { throw new Error("network touched"); });
  const { f, decision } = await seeded();
  const r = await load({}).call(`${decision}\n- ${GREY}\n`, f);
  assert.equal(calls.length, 0);
  assert.match(r.params.content, /"tier":"HYPOTHESIS"/);
});

test("sendUserTurn forwards the redacted prompt, only when enabled and available", async () => {
  stubFetch(() => json(ALLOW));
  const { f, decision } = await seeded();
  const k = load({ cloud: { ...CFG.cloud, sendUserTurn: true } });
  await k.hooks.llm_input.h({ runId: "r5", sessionId: "s", prompt: "mail me@corp.com about the sqlite file" }, {});
  await k.call(`${decision}\n- ${GREY}\n`, f, "r5");
  assert.match(calls[0].body.user_turn, /\[email\]/);
  assert.ok(!calls[0].body.user_turn.includes("me@corp.com"));
});
