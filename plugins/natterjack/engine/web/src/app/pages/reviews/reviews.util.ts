import type { ReviewPr, ReviewSummary } from '../../../../../shared/api';

export type ReviewFilter = 'requested' | 'all' | 'mine';

export interface ReviewFilters { filter: ReviewFilter; org: string; text: string; drafts: boolean }

/** A PR's key, "owner/name#n". */
export function prKey(p: { repo: string; number: number }): string { return `${p.repo}#${p.number}`; }

/**
 * The PRs a filter shows. Drafts are left out unless asked for (yours always show), org
 * matches the repo's owner, and text matches the title, repo, number or author.
 */
export function filterPrs(prs: ReviewPr[], f: ReviewFilters): ReviewPr[] {
  const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);
  return prs.filter((p) => {
    if (f.filter === 'requested' && !p.requested) return false;
    if (f.filter === 'mine' && !p.mine) return false;
    if (p.isDraft && !f.drafts && !p.mine) return false;
    if (f.org && p.repo.split('/')[0].toLowerCase() !== f.org.toLowerCase()) return false;
    if (!words.length) return true;
    const hay = `${p.title} ${p.repo}#${p.number} ${p.author || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * Whether to ask for a PR's summary: it has none, or the one it has is older than the PR's
 * last activity (maybe a push; the server answers from its saved one when the commit is the same).
 */
export function needsSummary(p: ReviewPr, made?: ReviewSummary | null): boolean {
  const s = made || p.summary;
  if (!s) return true;
  return Date.parse(s.at) < Date.parse(p.updatedAt);
}
