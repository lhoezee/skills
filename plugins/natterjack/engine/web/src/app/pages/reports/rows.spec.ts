import { describe, expect, it } from 'vitest';
import { type PersonRow, type SummaryDay, rowOf, rowsOf, windowStart } from './rows';

const day = (date: string, o: Partial<SummaryDay> = {}): SummaryDay => ({ date, runs: 1, succeeded: 1, failed: 0, tokens: 100, costUsd: 0.5, sessions: 1, ...o });
const person = (email: string, days: SummaryDay[], o: Partial<PersonRow> = {}): PersonRow => ({
  email, hasDashboard: true, running: false, lastSeen: null, activeDays7: 0, activeDays30: 0, collectedAt: null,
  summary: { version: 1, totals: { runs: days.length, rated: 4, good: 3 }, lastRunAt: null, days, presets: [{ id: 'explain', runs: 2 }], skills: [{ name: 'implement', runs: 5 }], weeklyLimitPct: 10 },
  ...o,
});

describe('reports rows', () => {
  it('windowStart: the first day of the 30 days ending on the report date', () => {
    expect(windowStart('2026-11-23T12:00:00')).toBe('2026-10-25');
    expect(windowStart('2026-11-23T12:00:00', 7)).toBe('2026-11-17');
  });

  it('counts only the days inside the window, so an old snapshot adds nothing', () => {
    // Stopped since October: its summary's days are all before the window.
    const stale = rowOf(person('old@x.com', [day('2026-10-01'), day('2026-10-20', { failed: 1 })]), '2026-10-25');
    expect([stale.runs30, stale.failed30, stale.tokens30, stale.cost30]).toEqual([0, 0, 0, 0]);
    const fresh = rowOf(person('new@x.com', [day('2026-10-24'), day('2026-10-25'), day('2026-11-23', { failed: 1, tokens: 50 })]), '2026-10-25');
    expect([fresh.runs30, fresh.failed30, fresh.tokens30, fresh.cost30]).toEqual([2, 1, 150, 1]);
  });

  it('most used, good share, and no summary yet', () => {
    const r = rowOf(person('a@x.com', []), '2026-10-25');
    expect(r.top).toBe('/implement (5), explain (2)');
    expect(r.goodPct).toBe(75);
    const none = rowOf(person('b@x.com', [], { summary: null }), '2026-10-25');
    expect([none.runs30, none.top, none.goodPct]).toEqual([0, '', null]);
  });

  it('rowsOf: most active first; people without a dashboard or figures are left out', () => {
    const rows = rowsOf({
      generatedAt: '2026-11-23T12:00:00', collectEveryMinutes: 15, kept: 'disk',
      people: [
        person('quiet@x.com', [], { activeDays30: 1 }),
        person('busy@x.com', [day('2026-11-23')], { activeDays30: 9 }),
        person('gone@x.com', [], { hasDashboard: false, summary: null }),
      ],
    });
    expect(rows.map((r) => r.email)).toEqual(['busy@x.com', 'quiet@x.com']);
  });
});
