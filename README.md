# Kalinov

**Epistemic gate for agent memory.** Your agent stops filing its own guesses as your orders.

Kalinov sits between an OpenClaw agent and its memory files. Every new memory line is classified into one of four tiers. Writes that contradict a user directive are rejected with a readable error the agent sees in-dialog. Expired hypotheses are physically deleted at the end of each session.

```
git clone https://github.com/metabolicrussianai/kalinov
cd kalinov
openclaw plugins install -l . --accept-capabilities
```

The package is not published to npm or ClawHub yet; install from source. Requires Node ≥ 22.6.

Works with no special permissions. One optional permission makes it much more accurate: with `plugins.entries.kalinov-most.hooks.allowConversationAccess: true`, Kalinov reads the user's prompt for the current run (the `llm_input` hook) and checks every line the agent writes against what the user actually said. Without it, only explicit evidence in the line itself (`User said: ...`) can promote a line above HYPOTHESIS, and a real model rarely writes that.

---

## The problem

Memory plugins compete on recall: store more, retrieve faster. None of them ask where a record came from.

You say: *"use SQLite for the prototype, we'll swap later."*
The agent stores: *"user prefers SQLite."*
A week later it defends that as your will — in production.

That's not a memory bug. It's a missing epistemic layer. Memory knows **what** was written. It doesn't know **who said it** or **how long it should live**.

## Four tiers

| Tier | Source | TTL | Can be overwritten by |
|---|---|---|---|
| `DIRECTIVE` | Explicit user instruction | Never expires | Another user directive only |
| `OBSERVATION` | Environment: API response, test output, command result | Until contradicted by environment | Newer observation of the same fact |
| `DECISION` | Agreed choice **with scope** (`"SQLite for prototype A until migration"`) | Until scope exits | User, or scope boundary |
| `HYPOTHESIS` | Model's own inference | N sessions (default: 3) | Anything above it |

A hypothesis never promotes itself to a directive.

## Conflict arbitration

When the agent tries to store something that contradicts an active `DIRECTIVE` or in-scope `DECISION`, the tool call is blocked and the agent receives (actual output, see `test/arbitration.test.ts`):

```json
{
  "error": "EpistemicConflictError",
  "attempted": { "tier": "HYPOTHESIS", "content": "user prefers SQLite" },
  "conflicts_with": {
    "tier": "DECISION",
    "id": "MEMORY.md#L4",
    "content": "User said: SQLite only for prototype A",
    "scope": "only for prototype A",
    "recorded_at": "2026-10-12T14:03:00.000Z"
  },
  "reason": "Attempting to generalize a scoped DECISION (\"only for prototype A\") into an unscoped claim.",
  "resolution": "Ask the user, or narrow the claim to the constraint's scope."
}
```

## How it works

Kalinov is a plain plugin in the OpenClaw hook pipeline. It does **not** occupy `plugins.slots.memory`. Hook and event shapes are taken from the OpenClaw source (`src/plugins/hook-types.ts`, `src/plugins/plugin-api.types.ts`, `src/agents/sessions/tools/{write,edit}.ts`).

### Write path — `before_tool_call` (matcher: `write`, `edit`, `apply_patch`)

The built-in memory has no dedicated write tool: the agent edits `MEMORY.md` and `memory/*.md` with the ordinary file tools.

- `write {path, content}` — Kalinov reads the current file and diffs by line. Lines that already exist keep their original text and tag; only **new** lines are classified, arbitrated and stamped. An agent rewriting the whole file can't re-label old memory.
- `edit {path, edits: [{oldText, newText}]}` (and the legacy top-level `oldText`/`newText`) — same rule per replacement: only lines in `newText` that aren't in `oldText` are tiered.

Kalinov returns params in the tool's native schema (`{path, content}` / `{path, edits}`) — never extra fields. On conflict it returns `{ block: true, blockReason }`.

**Fail-open.** The host treats `before_tool_call` as fail-closed: a thrown error blocks the tool. Kalinov catches its own errors, logs them and lets the write through unguarded. A bug in the gate must not cost the user their memory.

### Garbage collection — `session_end`

At the end of each session Kalinov advances its session counter and **deletes** stamped hypotheses whose TTL has run out, plus records marked contradicted. TTL counts sessions, not turns.

Kalinov never touches lines it did not stamp. Memory that pre-dates installation or was written by a human is invisible to GC.

### `apply_patch`

`apply_patch` rewrites files with no per-line hook point, so Kalinov does not try to tier it. A patch that touches a memory file is blocked with an `EpistemicGateBypass` error telling the agent to use `write` or `edit`. Patches to other files pass untouched.

### Not covered (yet)

- `exec` / shell redirection (`echo ... >> MEMORY.md`) can still write memory files. Deny `exec` for memory-writing agents, or use a sandbox, if that matters to you.
- Mem0 / Supermemory / LanceDB adapters are not started. Their auto-capture writes outside tool calls, so they will need post-hoc arbitration; `agent_end` is not an option without a conversation-access grant.
- No filtering on the read path: `before_prompt_build` is append-only. Deleting at the source is the honest alternative.

## Classifier and arbitration (local)

Both are heuristic, bilingual (EN/RU) and fully local — no model calls, no network. Classification is per line; list markers are stripped first.

- **Classifier** (`src/classifier.ts`): user-quote markers → `DIRECTIVE` (or `DECISION` if a scope is present); environment markers → `OBSERVATION`; scope markers → `DECISION`; everything else → `HYPOTHESIS`.
- **Arbitration** (`src/arbitration.ts`): subject overlap ≥ 0.5 on stance-free tokens, then one of three rules: generalizing a scoped decision, flipping a directive's polarity, or a lower tier generalizing over a directive.

Word matching uses Unicode-aware lookarounds (`src/lexicon.ts`). JavaScript's `\b` is ASCII-only and silently never matches around Cyrillic — don't reintroduce it.

The local layer is lexical, and it shows. On an author-labelled EN/RU eval set it caught almost none of the paraphrased or translated conflicts (recall 0.04 on the tuning set, 0.00 on the held-out set), and the negation-presence rule produces false blocks on compatible lines. It is good at the explicit cases it was written for: quoted user instructions, scoped decisions, environment output. For implicit contradictions it is a router to the cloud judge, not a judge. See "Status" for the numbers.

## Verified provenance

A heuristic over the agent's own wording cannot tell "the user said it" from "the agent inferred it": in live runs GLM wrote `Never deploy on Fridays.` with no marker at all, which would have been filed as a HYPOTHESIS and garbage-collected in three sessions. With conversation access granted, a line becomes a DIRECTIVE (or a scoped DECISION) when it is made of the user's words from this turn's prompt: at least 40% of the line's content words come from the prompt, and at least 60% of the prompt's content words survive in the line. It cannot be forged by phrasing, because it is checked against the real prompt. Hedged text (`probably`, `suspect`, `предположительно`, ...) never qualifies, reported environment output stays an OBSERVATION, and when the user asks to amend a line they already made binding, the re-worded line keeps its tier instead of being rejected as a lower-tier override.

`USER.md`: the stock OpenClaw template files "stable preferences and profile facts as active directives" there, not in `MEMORY.md`, so an inferred "user prefers X" would land in an unguarded file. `guardUserFile: true` gates it: lines with a verified user source are stamped, anything else is refused with `EpistemicUnverifiedDirective`, and a live model reacted by moving its guess to `MEMORY.md` as a HYPOTHESIS.

## Cloud arbitrator (optional)

Every classification carries a `confidence` (0..1): explicit quote .95, verified provenance .76-1, environment marker .85, scope marker .8, hedged .85, generalizing .6, no evidence .5. A line is grey-zone when local arbitration let it through, its confidence is below `uncertainBelow` (default 0.7), and the memory holds at least one active DIRECTIVE or DECISION. Constraints are ranked by subject overlap and the closest 8 are attached, with no lexical cut-off by default: real conflicts are often paraphrases or translations that share no words with the rule they break (`minRelatedOverlap: 0.25` restores the stricter, more private filter). At most 3 grey lines per write go to the arbitrator; everything else is decided locally with no network.

- **No key, no network.** Without `cloud.apiKey` or `KALINOV_API_KEY` Kalinov makes no request at all.
- **Minimal payload.** The candidate line and the related constraints, never the whole file or the conversation. The user's prompt is added only with `sendUserTurn` and `allowConversationAccess`. Secrets, e-mails and phone numbers are redacted locally first.
- **Fail-open.** 2.5 s budget (100-5000; an LLM judge takes 1.3-1.7 s, and only grey-zone lines wait for it). Timeout, network error, HTTP error or malformed reply returns the local decision. After 3 consecutive failures a circuit breaker skips the network for 60 s so a down service does not add latency to every write. Verdicts are cached for 24 h.
- **The server cannot forge binding memory.** It may block or demote at any time. It may promote a line to DIRECTIVE or DECISION only when the user's own prompt for the turn is available locally.
- **Block errors say who decided**: `"source": "cloud"` plus a `trace_id`.

This is data minimisation, not zero-knowledge: the candidate line and the attached constraints do leave the machine.

The default endpoint is the hosted arbitrator (`kalinov-cloud.onrender.com`; the server is not part of this repository). Override with `cloud.endpoint`. API keys are issued manually during the pre-release.

### Routing stats

Every gated write op is counted, and the counters persist across host restarts in `.kalinov/state.json` next to the session counter. `openclaw kalinov doctor` prints them, and one structured line (`kalinov: routing ...`, numbers only, no line texts) is logged per op. The headline number is `cloud_selected_lines / evaluated_lines`: the share of classified lines for which the cloud path was actually chosen.

- `evaluated_lines` — new content lines that reached classification. Lines after an early block were never classified; unchanged lines are never re-evaluated.
- `local_only_lines` — decided locally (confident, or grey-zone with no cloud path taken).
- `cloud_selected_lines` — grey-zone lines asked of the judge (≤ 3 per write). `cloud_capped_lines` — grey-zone lines beyond that cap.
- `blocked_lines` — rejected by a conflict; the remaining lines of that write were never evaluated.
- `cloud_network_requests`, `cloud_cache_hits`, `cloud_fallbacks` — transport behind the routing choice. A cache hit does not touch the network but still counts as routed; a failure is a fallback, not an unrouted line: the local decision stands.

Invariant by construction: `evaluated_lines = local_only_lines + cloud_selected_lines + cloud_capped_lines + blocked_lines`.

Why this exists: on the eval sets below, ~95% of lines went to the judge — but that is author-labelled data, not live traffic. The counters are how the live share gets measured: run the gate on a real host doing real work, and `doctor` reports what actually happened. `apply_patch` bypass attempts never reach line classification and are not counted as write ops.

## Configuration

Zero-config by default. Optional, in `plugins.entries.kalinov-most.config`:

```json5
{
  hypothesisTtlSessions: 3,
  strictMode: false,   // true: block memory lines the classifier cannot tier
  workspaceDir: "~/.openclaw/workspace",  // base for relative paths; default: the calling agent's workspace
  guardUserFile: false,  // true: also gate USER.md (see below)
  cloud: {               // optional; see "Cloud arbitrator". No apiKey, no network.
    // apiKey: "klv_live_...",  // or env KALINOV_API_KEY
    // endpoint: "https://kalinov-cloud.onrender.com/v1/arbitrate",
    timeoutMs: 2500,       // 100-5000
    sendUserTurn: false,   // also needs hooks.allowConversationAccess
    uncertainBelow: 0.7,
    minRelatedOverlap: 0   // 0.25: attach only lexically related constraints
  }
}
```

## Development

Requires Node ≥ 22.6 (native TypeScript type stripping).

```
npm test          # node --test --experimental-strip-types test/
npm run typecheck # tsc, after npm install
```

69 tests: classifier (EN/RU), arbitration, markdown adapter, GC safety, the cloud client (timeout, breaker, cache, redaction, no-promotion rule), and the plugin entry driven through a fake API with the real hook signatures — including whole-file rewrites, legacy edit input, fail-open, and session-based TTL. Unit tests, not live scenarios; the live runs are listed under "Status".

## Open core

Everything in this repository is MIT. A plugin that reads every write to your agent's memory and runs inside the Gateway process has no business being a black box.

The paid tier (Kalinov Cloud) is the hosted semantic judge for grey-zone lines. Calls are metered on the server, per key: a counter in the plugin would be one file edit away from unlimited.

- **Available now (pre-release):** hosted arbitration, server-side quota, manually issued keys. 100 judge calls a month free.
- **Planned, not built:** intercept history dashboard, directive sync across a team's agents, `openclaw kalinov login`, self-serve billing. Target pricing $29/mo per agent, $99/mo per team.

## Status

**Pre-release. Verified against a live OpenClaw Gateway (2026.10.5), with a scripted model and with a real one (GLM-4.6).**

Scripted model (`scripts/live-e2e/`): plugin loads and hooks fire; `write` stamps new lines and keeps old ones; generalizing a scoped DECISION via `write` or `edit` is blocked with a readable `EpistemicConflictError`; `apply_patch` on memory is blocked and on other files passes; `session_end` GC deletes expired hypotheses and keeps directives; `openclaw kalinov doctor` runs.

Real model, five scenario types, EN and RU:

| Scenario | Outcome |
|---|---|
| "Save: never deploy on Fridays" | DIRECTIVE |
| "SQLite only for prototype A, then Postgres" (EN, RU) | DECISION with scope |
| "Test run returned exit code 0, 42 passed" | OBSERVATION |
| "I suspect the cache is slow, save your hypothesis" | HYPOTHESIS |
| "Update that line to also say: use conventional commits" | amendment accepted, DIRECTIVE kept |
| "Remember I use Neovim" with `guardUserFile` | stamped DIRECTIVE in USER.md |
| "Add your guess that I'm a night owl" to USER.md | refused; the model moved it to MEMORY.md as HYPOTHESIS |

Bugs that only a live host exposed, all fixed and covered by regression tests: relative paths resolved against the Gateway's cwd (the gate was blind); the host prefixes prompts with `[Mon 2026-10-19 13:07 UTC]`, which diluted the provenance match; models quote `edit` text without the trailing tag, which left the tag dangling on the wrong line; comment-only lines (`<!-- observed: ... -->`) were stamped as memory and later garbage-collected.

Cloud client, first against a local stand-in server: no key sends nothing; a block verdict reaches the agent as `EpistemicConflictError` with `source: cloud`; an unresponsive server costs the configured timeout and the write proceeds on the local decision; confident lines never reach the network; an email in the line arrives as `[email]`. Then against the hosted arbitrator: a live Gateway received a cloud block, and the call was metered on the server.

### Eval

An author-labelled set of 168 EN/RU memory lines against active constraints. The tuning set (120 lines) was used to adjust routing and the judge; the held-out set (48 lines, 24 meanings in both languages) was not. Neither is an independent third-party labelling, and the sets are small: read the intervals, not the point estimates.

| System | Set | Conflict recall | False-block rate |
|---|---|---|---|
| Local only | tuning / held-out | 0.04 / 0.00 | 0.00 / 0.08 |
| Local + cloud judge | tuning, before / after tuning | 0.67 / 0.98 | 0.12 / 0.06 |
| Local + cloud judge | held-out | 1.00 (95% CI 0.86-1.00) | 0.21 (95% CI 0.09-0.41) |

Read it plainly: the local layer alone does not catch implicit conflicts, and the hybrid buys its recall with false blocks. After routing was widened, about 95% of the eval lines went to the judge; the share on real agent traffic is not measured.

### Known holes

- `exec` / shell writes bypass the file hooks (see "Not covered").
- An agent can still drop or silently re-word a DIRECTIVE in a turn where the user asked for nothing of the kind: removal of a binding line is not gated yet.
- The local negation rule blocks some compatible lines as polarity flips.

Not verified: more than one model end to end, multi-agent setups beyond unit tests, restart/upgrade behaviour.

Kalinov narrows how memory goes wrong. It is not complete protection of agent memory, and this README does not claim it is.

## License

MIT
