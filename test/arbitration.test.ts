import { test } from "node:test";
import assert from "node:assert/strict";
import { arbitrate } from "../src/arbitration.ts";
import type { Constraint } from "../src/adapters/types.ts";

const sqliteDecision: Constraint = {
  id: "MEMORY.md#L1", tier: "DECISION", content: "User said: SQLite only for prototype A",
  scope: "only for prototype A", recordedAt: "2026-10-12T14:03:00Z",
};
const fridayDirective: Constraint = {
  id: "MEMORY.md#L2", tier: "DIRECTIVE", content: "User said: never deploy on Friday", recordedAt: "2026-10-12T14:05:00Z",
};
const ruDecision: Constraint = {
  id: "MEMORY.md#L3", tier: "DECISION", content: "Пользователь сказал: SQLite только для прототипа А",
  scope: "только для прототипа А", recordedAt: "2026-10-12T14:06:00Z",
};

test("the SQLite case: generalizing a scoped decision is blocked", () => {
  const r = arbitrate({ tier: "HYPOTHESIS", content: "user prefers SQLite" }, [sqliteDecision]);
  assert.ok(r);
  assert.equal(r!.error, "EpistemicConflictError");
  assert.equal(r!.conflicts_with.id, "MEMORY.md#L1");
  assert.match(r!.reason, /generalize a scoped DECISION/);
});

test("the SQLite case in Russian", () => {
  assert.ok(arbitrate({ tier: "HYPOTHESIS", content: "юзер предпочитает SQLite" }, [ruDecision]));
});

test("polarity flip against a directive is blocked", () => {
  const r = arbitrate({ tier: "HYPOTHESIS", content: "deploy on Friday is fine" }, [fridayDirective]);
  assert.match(r?.reason ?? "", /Polarity/);
});

test("a neutral observation about the same subject passes", () => {
  assert.equal(arbitrate({ tier: "OBSERVATION", content: "SQLite schema has 3 tables" }, [sqliteDecision]), null);
});

test("a scoped restatement passes", () => {
  assert.equal(arbitrate({ tier: "DECISION", content: "SQLite for prototype A", scope: "for prototype A" }, [sqliteDecision]), null);
});

test("unrelated records pass", () => {
  assert.equal(arbitrate({ tier: "HYPOTHESIS", content: "Docker image is 300MB" }, [sqliteDecision, fridayDirective]), null);
});

test("bounds like 'no later than' / 'не позднее' are not negation: a compatible restatement is not a polarity flip", () => {
  const retention: Constraint = { id: "MEMORY.md#L9", tier: "DIRECTIVE", content: "Delete raw access logs no later than 7 days after creation", recordedAt: "2026-10-01T00:00:00Z" };
  assert.equal(arbitrate({ tier: "HYPOTHESIS", content: "Raw access logs are deleted on day 6" }, [retention]), null);
  const ru: Constraint = { id: "MEMORY.md#L10", tier: "DIRECTIVE", content: "Удалять сырые логи доступа не позднее 7 дней после создания", recordedAt: "2026-10-01T00:00:00Z" };
  assert.equal(arbitrate({ tier: "HYPOTHESIS", content: "Сырые логи доступа удаляются на шестой день" }, [ru]), null);
  // real negation still flips
  assert.ok(arbitrate({ tier: "HYPOTHESIS", content: "deploy on Friday is fine" }, [{ id: "x", tier: "DIRECTIVE", content: "never deploy on Friday", recordedAt: "2026-10-01T00:00:00Z" }]));
});
