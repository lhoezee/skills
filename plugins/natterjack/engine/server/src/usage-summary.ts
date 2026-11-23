/**
 * How much this dashboard is used, as totals only: GET /api/usage/summary. The hosted router
 * collects it from every person's dashboard for the admins' Reports page (router/src/usage.ts),
 * so it never carries what anyone asked or got back: no prompts, no result text, no file
 * names. The one thing taken from a prompt is the name of the slash command it starts with
 * ("/implement"), and only when it's a command this dashboard knows (the list it already
 * cached for autocomplete): "/customer-123.csv is broken" starts with a slash too, and that
 * name must not leave. With no cached list, no skills are reported; collecting never starts
 * Claude to get one.
 *
 * Everything here is already on the dashboard's own disk: the run records (ledger), the
 * Claude transcripts' token counts (usage-history.ts) and the last /usage reading
 * (usage.ts). Building it starts nothing and costs nothing.
 */

import type { TokenCounts } from "./usage-history.ts";

export const SUMMARY_VERSION = 1;
const TOP = 10;

/** The run fields the summary reads (RunMeta has more). */
export interface SummaryRun {
  presetId: string | null;
  prompt: string;
  trigger: string;
  status: string;
  startedAt: string;
  turns: number;
  costUsd: number;
  durationMs: number | null;
  toolCalls: number;
  verdict: "good" | "needed-fix" | null;
}

export interface SummaryDay {
  date: string;
  runs: number;
  succeeded: number;
  failed: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
  costUsd: number;
  tokens: number;
  sessions: number;
}

export interface UsageSummary {
  version: number;
  generatedAt: string;
  /** All time, from the run records (tokens: the days the transcripts cover). */
  totals: { runs: number; succeeded: number; failed: number; turns: number; toolCalls: number; durationMs: number; costUsd: number; rated: number; good: number; tokens: number };
  firstRunAt: string | null;
  lastRunAt: string | null;
  /** The last `days` days, oldest first. */
  days: SummaryDay[];
  /** Most used, all time. */
  presets: { id: string; runs: number }[];
  skills: { name: string; runs: number }[];
  /** How runs were started: manual, preset, routine, issues, ask... */
  triggers: Record<string, number>;
  /** The weekly limit's last /usage reading, when there is one. */
  weeklyLimitPct: number | null;
}

/** "/implement ENG-1 ..." → "implement"; "/natterjack:host" → "natterjack:host"; anything else → null. */
export function skillOf(prompt: string): string | null {
  const m = /^\s*\/([a-z0-9][\w:.-]{0,80})(?=\s|$)/i.exec(String(prompt || ""));
  return m ? m[1].toLowerCase() : null;
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const tokenTotal = (c: TokenCounts) => c.input + c.output + c.cacheRead + c.cacheWrite;
const top = (counts: Map<string, number>) => [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP);

export function usageSummary(input: {
  runs: SummaryRun[];
  /** usage-history.ts report().days */
  tokenDays: { date: string; byModel: Record<string, TokenCounts>; sessions: number }[];
  /** usage.ts history(): [{ at, meters: [{ kind, pct }] }] */
  limits: { at: string; meters: { kind: string; pct: number }[] }[];
  /** Slash commands this dashboard knows (lowercase, no slash); null = none known, so no skills reported. */
  knownCommands: Set<string> | null;
  days: number;
  now?: Date;
}): UsageSummary {
  const now = input.now || new Date();
  const days = new Map<string, SummaryDay>();
  for (let i = input.days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0); // midday: a DST change can't skip or repeat a date
    d.setDate(d.getDate() - i);
    const date = localDate(d);
    days.set(date, { date, runs: 0, succeeded: 0, failed: 0, turns: 0, toolCalls: 0, durationMs: 0, costUsd: 0, tokens: 0, sessions: 0 });
  }
  const totals = { runs: 0, succeeded: 0, failed: 0, turns: 0, toolCalls: 0, durationMs: 0, costUsd: 0, rated: 0, good: 0, tokens: 0 };
  const presets = new Map<string, number>();
  const skills = new Map<string, number>();
  const triggers: Record<string, number> = {};
  let firstRunAt: string | null = null, lastRunAt: string | null = null;

  for (const r of input.runs) {
    const t = new Date(r.startedAt);
    if (isNaN(t.getTime())) continue;
    const turns = r.turns || 1, cost = r.costUsd || 0, dur = r.durationMs || 0, tools = r.toolCalls || 0;
    totals.runs++;
    totals.turns += turns;
    totals.toolCalls += tools;
    totals.durationMs += dur;
    totals.costUsd += cost;
    if (r.status === "succeeded") totals.succeeded++;
    if (r.status === "failed") totals.failed++;
    if (r.verdict) { totals.rated++; if (r.verdict === "good") totals.good++; }
    if (!firstRunAt || r.startedAt < firstRunAt) firstRunAt = r.startedAt;
    if (!lastRunAt || r.startedAt > lastRunAt) lastRunAt = r.startedAt;
    if (r.presetId) presets.set(r.presetId, (presets.get(r.presetId) || 0) + 1);
    const skill = skillOf(r.prompt);
    if (skill && input.knownCommands?.has(skill)) skills.set(skill, (skills.get(skill) || 0) + 1);
    const trig = String(r.trigger || "manual").startsWith("routine:") ? "routine" : r.presetId ? "preset" : String(r.trigger || "manual");
    triggers[trig] = (triggers[trig] || 0) + 1;
    const day = days.get(localDate(t));
    if (!day) continue;
    day.runs++;
    day.turns += turns;
    day.toolCalls += tools;
    day.durationMs += dur;
    day.costUsd += cost;
    if (r.status === "succeeded") day.succeeded++;
    if (r.status === "failed") day.failed++;
  }

  for (const td of input.tokenDays) {
    const n = Object.values(td.byModel || {}).reduce((s, c) => s + tokenTotal(c), 0);
    totals.tokens += n;
    const day = days.get(td.date);
    if (day) { day.tokens += n; day.sessions += td.sessions || 0; }
  }

  let weeklyLimitPct: number | null = null;
  for (const snap of [...input.limits].sort((a, b) => a.at.localeCompare(b.at))) {
    const week = (snap.meters || []).find((m) => m.kind === "week");
    if (week && Number.isFinite(week.pct)) weeklyLimitPct = week.pct;
  }

  totals.costUsd = Math.round(totals.costUsd * 100) / 100;
  for (const d of days.values()) d.costUsd = Math.round(d.costUsd * 100) / 100;
  return {
    version: SUMMARY_VERSION,
    generatedAt: now.toISOString(),
    totals,
    firstRunAt,
    lastRunAt,
    days: [...days.values()],
    presets: top(presets).map(([id, runs]) => ({ id, runs })),
    skills: top(skills).map(([name, runs]) => ({ name, runs })),
    triggers,
    weeklyLimitPct,
  };
}
