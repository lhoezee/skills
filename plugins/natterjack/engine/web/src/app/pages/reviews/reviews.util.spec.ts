import { describe, expect, it } from 'vitest';
import type { ReviewPr } from '../../../../../shared/api';
import { filterPrs, needsSummary, prKey } from './reviews.util';

function pr(over: Partial<ReviewPr> = {}): ReviewPr {
  return {
    repo: 'acme/api', number: 1, title: 'Add retries', url: 'https://github.com/acme/api/pull/1',
    author: 'sam', authorIsBot: false, isDraft: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
    labels: [], comments: 0, requested: false, mine: false, summary: null, ...over,
  };
}

const base = { filter: 'all' as const, org: '', text: '', drafts: false };

describe('filterPrs', () => {
  it('keeps requested and mine to their own filters', () => {
    const prs = [pr({ number: 1, requested: true }), pr({ number: 2, mine: true }), pr({ number: 3 })];
    expect(filterPrs(prs, { ...base, filter: 'requested' }).map((p) => p.number)).toEqual([1]);
    expect(filterPrs(prs, { ...base, filter: 'mine' }).map((p) => p.number)).toEqual([2]);
    expect(filterPrs(prs, base).length).toBe(3);
  });

  it('hides other people\'s drafts unless asked, but never yours', () => {
    const prs = [pr({ number: 1, isDraft: true }), pr({ number: 2, isDraft: true, mine: true })];
    expect(filterPrs(prs, base).map((p) => p.number)).toEqual([2]);
    expect(filterPrs(prs, { ...base, drafts: true }).length).toBe(2);
  });

  it('matches the org by owner and the text by every word', () => {
    const prs = [pr({ repo: 'acme/api', title: 'Add retries' }), pr({ repo: 'other/web', number: 7, author: 'kim', title: 'Fix login' })];
    expect(filterPrs(prs, { ...base, org: 'ACME' }).map((p) => p.repo)).toEqual(['acme/api']);
    expect(filterPrs(prs, { ...base, text: 'kim login' }).map((p) => p.number)).toEqual([7]);
    expect(filterPrs(prs, { ...base, text: 'web#7' }).length).toBe(1);
    expect(filterPrs(prs, { ...base, text: 'retries kim' }).length).toBe(0);
  });
});

describe('needsSummary', () => {
  it('asks when there is none, or it is older than the last activity', () => {
    expect(needsSummary(pr())).toBe(true);
    expect(needsSummary(pr({ summary: { text: 'x', sha: 'a', at: '2026-10-03T00:00:00Z' } }))).toBe(false);
    expect(needsSummary(pr({ summary: { text: 'x', sha: 'a', at: '2026-10-01T00:00:00Z' } }))).toBe(true);
    expect(needsSummary(pr({ summary: { text: 'x', sha: 'a', at: '2026-10-01T00:00:00Z' } }), { text: 'y', sha: 'b', at: '2026-10-05T00:00:00Z' })).toBe(false);
  });

  it('keys a PR by repo and number', () => {
    expect(prKey({ repo: 'acme/api', number: 4 })).toBe('acme/api#4');
  });
});
