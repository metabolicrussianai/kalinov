import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/classifier.ts";

const cases: Array<[string, string, Partial<{ claimedTier: any }>?]> = [
  ["User said: SQLite only for prototype A", "DECISION"],
  ["User said: never deploy on Friday", "DIRECTIVE"],
  ["user prefers SQLite", "HYPOTHESIS"],
  ["npm test failed with exit code 1", "OBSERVATION"],
  ["API returned status 429", "OBSERVATION"],
  ["Пользователь сказал: не трогать прод", "DIRECTIVE"],
  ["Пользователь сказал: SQLite только для прототипа А", "DECISION"],
  ["юзер всегда хочет SQLite", "HYPOTHESIS"],
  ["тесты упали на CI", "OBSERVATION"],
  ["Redis для прототипа", "DECISION"],
];

for (const [text, tier] of cases) {
  test(`classify: ${text} → ${tier}`, () => assert.equal(classify({ content: text }).tier, tier));
}

test("self-claimed DIRECTIVE without a user quote is downgraded", () => {
  const r = classify({ content: "always use tabs", claimedTier: "DIRECTIVE" });
  assert.equal(r.tier, "HYPOTHESIS");
  assert.equal(r.downgraded, true);
});

test("Cyrillic generalizer is detected (JS \\b is ASCII-only)", () => {
  assert.match(classify({ content: "юзер всегда хочет SQLite" }).reason, /generalizing/);
});

test("scope is extracted", () => {
  assert.match(classify({ content: "User said: SQLite only for prototype A" }).scope ?? "", /prototype A/);
});

import { userProvenance } from "../src/provenance.ts";
test("provenance: a plain restatement of the user's instruction is a DIRECTIVE", () => {
  const r = classify({ content: "Never deploy on Fridays.", userText: "Save to your memory: never deploy on Fridays." });
  assert.equal(r.tier, "DIRECTIVE");
});
test("provenance: scope is taken from the user's message when the agent paraphrases", () => {
  const r = classify({ content: "SQLite is limited to Prototype A. After validation migrate to Postgres.", userText: "Remember: SQLite only for prototype A, then we migrate to Postgres." });
  assert.equal(r.tier, "DECISION");
  assert.match(r.scope ?? "", /only for prototype A/i);
});
test("provenance: Russian inflections still match", () => {
  assert.equal(classify({ content: "SQLite ограничен прототипом А", userText: "Запомни: SQLite только для прототипа А" }).tier, "DECISION");
});
test("provenance: the agent's own inference is not promoted, even when it echoes the user's words", () => {
  assert.equal(classify({ content: "The cache layer is likely slow.", userText: "I suspect the cache layer is slow. Save your hypothesis." }).tier, "HYPOTHESIS");
  assert.equal(classify({ content: "User probably wants Postgres in production", userText: "Save to memory: we use SQLite for the prototype." }).tier, "HYPOTHESIS");
});
test("provenance: a line unrelated to the user's message stays a HYPOTHESIS", () => {
  assert.equal(classify({ content: "The build takes ten minutes on CI.", userText: "Remember: never deploy on Fridays." }).tier, "HYPOTHESIS");
});
test("provenance: reported environment output is an OBSERVATION, not a directive", () => {
  assert.equal(classify({ content: "Test run returned exit code 0, 42 tests passed.", userText: "Save to memory: the test run returned exit code 0, all 42 tests passed." }).tier, "OBSERVATION");
});

test("provenance: the host's timestamp envelope on the prompt does not dilute the match (found with a live Gateway)", () => {
  const r = classify({ content: "Never deploy on Fridays.", userText: "[Mon 2026-10-19 13:07 UTC] Save to your memory: never deploy on Fridays." });
  assert.equal(r.tier, "DIRECTIVE");
});

test("amendment inheritance requires the user's prompt and a recognisably-same record", async () => {
  const { planText } = await import("../src/memory-write.ts");
  const { stampLine } = await import("../src/adapters/markdown.ts");
  const before = stampLine("- Always write commit messages in English.", { tier: "DIRECTIVE", recordedAt: "2026-10-01T00:00:00Z" }) + "\n";
  const meta = (r: any) => ({ tier: r.tier, recordedAt: "2026-10-19T00:00:00Z" });
  const constraints = [{ id: "c", tier: "DIRECTIVE" as const, content: "Always write commit messages in English.", recordedAt: "2026-10-01T00:00:00Z" }];
  const after = "- Always write commit messages in English using conventional commits.\n";
  const user = "Update that line to also say: use conventional commits.";
  assert.equal(planText(before, after, constraints as any, meta as any, user).ok, true);
  assert.equal(planText(before, after, constraints as any, meta as any, undefined).ok, false, "no prompt, no inheritance");
  assert.equal(planText(before, "- Releases happen on Tuesdays.\n", constraints as any, meta as any, user).ok, true, "unrelated line is just a hypothesis");
});
