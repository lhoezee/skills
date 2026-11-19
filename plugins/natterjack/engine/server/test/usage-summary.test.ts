import { test } from "node:test";
import assert from "node:assert/strict";
import { skillOf, usageSummary, type SummaryRun } from "../src/usage-summary.ts";

const NOW = new Date(2026, 10, 19, 15, 0, 0); // 19 Nov 2026, local time
const at = (day: number, hour = 10) => new Date(2026, 10, day, hour).toISOString();
const run = (o: Partial<SummaryRun>): SummaryRun => ({
  presetId: null, prompt: "hello", trigger: "manual", status: "succeeded", startedAt: at(19),
  turns: 1, costUsd: 0, durationMs: 0, toolCalls: 0, verdict: null, ...o,
});
const tok = (n: number) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 });

test("skillOf: the slash command a prompt starts with, nothing else", () => {
  assert.equal(skillOf("/implement ENG-1 please"), "implement");
  assert.equal(skillOf("  /natterjack:host"), "natterjack:host");
  assert.equal(skillOf("please run /implement"), null);
  assert.equal(skillOf("/ not a command"), null);
  assert.equal(skillOf("/path/to/file is broken"), null);
  assert.equal(skillOf(""), null);
});

test("usageSummary: totals, days, presets, skills and triggers, with no prompt text", () => {
  const SECRET = "the customer's account number is 12345";
  const s = usageSummary({
    runs: [
      run({ prompt: `/implement ENG-1 ${SECRET}`, costUsd: 1.234, turns: 3, toolCalls: 7, durationMs: 60000, verdict: "good" }),
      run({ prompt: SECRET, presetId: "explain", status: "failed", startedAt: at(18), costUsd: 0.5 }),
      run({ prompt: "/implement ENG-2", trigger: "routine:daily", status: "cancelled", startedAt: at(1) }), // before the 30 days
      run({ startedAt: "not a date" }),
    ],
    tokenDays: [
      { date: "2026-11-19", byModel: { "claude-opus-5-5": tok(1000), "claude-haiku-5-5": tok(5) }, sessions: 2 },
      { date: "2026-11-18", byModel: { "claude-opus-5-5": tok(10) }, sessions: 1 },
    ],
    limits: [
      { at: "2026-11-19T10:00:00Z", meters: [{ kind: "session", pct: 3 }, { kind: "week", pct: 41 }] },
      { at: "2026-11-18T10:00:00Z", meters: [{ kind: "week", pct: 20 }] },
    ],
    days: 30,
    now: NOW,
  });

  assert.ok(!JSON.stringify(s).includes("12345"), "no prompt text in the summary");
  assert.equal(s.totals.runs, 3);
  assert.equal(s.totals.succeeded, 1);
  assert.equal(s.totals.failed, 1);
  assert.equal(s.totals.turns, 5);
  assert.equal(s.totals.costUsd, 1.73);
  assert.deepEqual([s.totals.rated, s.totals.good], [1, 1]);
  assert.equal(s.totals.tokens, 1015);
  assert.equal(s.firstRunAt, at(1));
  assert.equal(s.lastRunAt, at(19));

  assert.equal(s.days.length, 30);
  assert.equal(s.days.at(-1)!.date, "2026-11-19");
  assert.equal(s.days[0].date, "2026-10-21");
  const today = s.days.at(-1)!, yesterday = s.days.at(-2)!;
  assert.deepEqual([today.runs, today.succeeded, today.toolCalls, today.durationMs, today.tokens, today.sessions], [1, 1, 7, 60000, 1005, 2]);
  assert.equal(today.costUsd, 1.23);
  assert.deepEqual([yesterday.runs, yesterday.failed, yesterday.tokens], [1, 1, 10]);

  assert.deepEqual(s.presets, [{ id: "explain", runs: 1 }]);
  assert.deepEqual(s.skills, [{ name: "implement", runs: 2 }]);
  assert.deepEqual(s.triggers, { manual: 1, preset: 1, routine: 1 });
  assert.equal(s.weeklyLimitPct, 41, "the newest week reading");
});

test("usageSummary: an unused dashboard is all zeros", () => {
  const s = usageSummary({ runs: [], tokenDays: [], limits: [], days: 7, now: NOW });
  assert.equal(s.days.length, 7);
  assert.equal(s.totals.runs, 0);
  assert.equal(s.firstRunAt, null);
  assert.equal(s.weeklyLimitPct, null);
});
