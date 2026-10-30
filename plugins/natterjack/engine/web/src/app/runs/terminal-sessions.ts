import type { TerminalSession } from '../../../../shared/api';

/** Where a session was started, as the list names it: "Claude desktop" for claude-desktop, nothing for a terminal. */
export function entrypointLabel(e: string | null): string {
  if (!e || e === 'cli') return '';
  const name = e.replace(/^claude-/, '');
  return name === 'vscode' ? 'VS Code' : name === 'desktop' ? 'Claude desktop' : name;
}

/** The list in groups: the workspace's own sessions first, then each other folder's (Settings), in the order they come. */
export function sessionGroups(sessions: readonly TerminalSession[]): { folder: string | null; sessions: TerminalSession[] }[] {
  const groups: { folder: string | null; sessions: TerminalSession[] }[] = [];
  for (const s of sessions) {
    let g = groups.find((x) => x.folder === s.folder);
    if (!g) groups.push((g = { folder: s.folder, sessions: [] }));
    g.sessions.push(s);
  }
  return groups.sort((a, b) => (a.folder === null ? -1 : b.folder === null ? 1 : 0));
}
