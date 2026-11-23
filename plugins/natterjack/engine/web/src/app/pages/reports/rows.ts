/** engine server/src/usage-summary.ts, as the router keeps it (router/src/usage.ts cleanSummary). */
export interface SummaryDay { date: string; runs: number; succeeded: number; failed: number; tokens: number; costUsd: number; sessions: number }
export interface UsageSummary {
  version: number;
  totals: { runs: number; rated: number; good: number };
  lastRunAt: string | null;
  days: SummaryDay[];
  presets: { id: string; runs: number }[];
  skills: { name: string; runs: number }[];
  weeklyLimitPct: number | null;
}
/** router/src/usage.ts usageReport() */
export interface PersonRow {
  email: string;
  hasDashboard: boolean;
  running: boolean | null;
  lastSeen: string | null;
  activeDays7: number;
  activeDays30: number;
  collectedAt: string | null;
  summary: UsageSummary | null;
}
export interface UsageReportResponse { generatedAt: string; people: PersonRow[]; collectEveryMinutes: number; kept: 'disk' | 'memory' }

export interface Row extends PersonRow {
  runs30: number;
  failed30: number;
  tokens30: number;
  cost30: number;
  top: string;
  goodPct: number | null;
}

/** "YYYY-MM-DD" 29 days before the report (or now): the first day of its 30-day window. */
export function windowStart(generatedAt: string | null | undefined, days = 30): string {
  const t = generatedAt ? new Date(generatedAt) : new Date();
  const d = isNaN(t.getTime()) ? new Date() : t;
  d.setDate(d.getDate() - (days - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * One person's row. The 30-day figures count only the days inside the current window: a
 * dashboard stopped for over a month keeps its last summary, whose days are old by now.
 */
export function rowOf(p: PersonRow, since: string): Row {
  const days = (p.summary?.days || []).filter((d) => d.date >= since);
  const t = p.summary?.totals;
  const top = [...(p.summary?.skills || []).map((s) => ({ n: `/${s.name}`, c: s.runs })), ...(p.summary?.presets || []).map((s) => ({ n: s.id, c: s.runs }))]
    .sort((a, b) => b.c - a.c).slice(0, 3).map((x) => `${x.n} (${x.c})`).join(', ');
  return {
    ...p,
    runs30: days.reduce((s, d) => s + d.runs, 0),
    failed30: days.reduce((s, d) => s + d.failed, 0),
    tokens30: days.reduce((s, d) => s + d.tokens, 0),
    cost30: days.reduce((s, d) => s + d.costUsd, 0),
    top,
    goodPct: t && t.rated ? Math.round((t.good / t.rated) * 100) : null,
  };
}

/** Most active first. */
export function rowsOf(report: UsageReportResponse | null): Row[] {
  const since = windowStart(report?.generatedAt);
  return (report?.people || []).filter((p) => p.hasDashboard || p.summary).map((p) => rowOf(p, since))
    .sort((a, b) => b.activeDays30 - a.activeDays30 || b.runs30 - a.runs30 || a.email.localeCompare(b.email));
}
