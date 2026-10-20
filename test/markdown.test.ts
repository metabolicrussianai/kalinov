import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MarkdownAdapter, stampLine } from "../src/adapters/markdown.ts";
import { runGC } from "../src/gc.ts";

const ws = () => mkdtemp(path.join(tmpdir(), "kalinov-"));

test("matchesPath only accepts memory files", async () => {
  const a = new MarkdownAdapter(await ws());
  assert.ok(a.matchesPath("MEMORY.md"));
  assert.ok(a.matchesPath("memory/2026-10-19.md"));
  assert.ok(!a.matchesPath("src/index.ts"));
  assert.ok(!a.matchesPath("memory/nested/x.md"));
  assert.ok(!a.matchesPath("../MEMORY.md"));
  assert.ok(!a.matchesPath(undefined));
});

test("doctor round-trips write/list/delete", async () => {
  const r = await new MarkdownAdapter(await ws()).doctor();
  assert.deepEqual(r, { ok: true, detail: "write/list/delete round-trip ok" });
});

test("GC deletes expired hypotheses, keeps directives and human lines", async () => {
  const dir = await ws();
  const a = new MarkdownAdapter(dir);
  const now = new Date().toISOString();
  await writeFile(path.join(dir, "MEMORY.md"), [
    "# Memory",
    "Hand-written note by the human",
    stampLine("User said: never deploy on Friday", { tier: "DIRECTIVE", recordedAt: now, recordedSession: 0 }),
    stampLine("user probably likes tabs", { tier: "HYPOTHESIS", recordedAt: now, recordedSession: 0, expiresAfterSessions: 3 }),
    stampLine("maybe Redis later", { tier: "HYPOTHESIS", recordedAt: now, recordedSession: 2, expiresAfterSessions: 3 }),
  ].join("\n"));

  const [rep] = await runGC([a], 3, new Date(now), 3, () => {});
  assert.equal(rep.expired, 1);
  const text = await readFile(path.join(dir, "MEMORY.md"), "utf8");
  assert.match(text, /Hand-written note/);
  assert.match(text, /never deploy on Friday/);
  assert.match(text, /maybe Redis later/);
  assert.doesNotMatch(text, /likes tabs/);
});

test("pre-existing unstamped memory is never touched", async () => {
  const dir = await ws();
  await mkdir(path.join(dir, "memory"));
  const original = "user prefers SQLite\nsome old fact\n";
  await writeFile(path.join(dir, "memory", "2026-01-01.md"), original);
  const a = new MarkdownAdapter(dir);
  for (let s = 0; s < 10; s++) await runGC([a], s, new Date(0), 3, () => {});
  assert.equal(await readFile(path.join(dir, "memory", "2026-01-01.md"), "utf8"), original);
});
