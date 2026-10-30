import { describe, expect, it } from 'vitest';
import type { TerminalSession } from '../../../../shared/api';
import { entrypointLabel, sessionGroups } from './terminal-sessions';

const s = (id: string, folder: string | null): TerminalSession => ({ sessionId: id, cwd: folder || 'C:/ws', label: id, branch: null, entrypoint: 'cli', startedAt: null, lastActivityAt: '2026-10-30T00:00:00Z', workspace: 'main', folder, movedTo: null, live: false });

describe('sessionGroups', () => {
  it("puts the workspace's own first, then each other folder, keeping each list's order", () => {
    const g = sessionGroups([s('a', 'C:/old'), s('b', null), s('c', 'C:/other'), s('d', 'C:/old'), s('e', null)]);
    expect(g.map((x) => x.folder)).toEqual([null, 'C:/old', 'C:/other']);
    expect(g[0].sessions.map((x) => x.sessionId)).toEqual(['b', 'e']);
    expect(g[1].sessions.map((x) => x.sessionId)).toEqual(['a', 'd']);
  });
});

describe('entrypointLabel', () => {
  it('names the desktop app and IDEs, not the terminal', () => {
    expect(entrypointLabel('cli')).toBe('');
    expect(entrypointLabel('claude-desktop')).toBe('Claude desktop');
    expect(entrypointLabel('claude-vscode')).toBe('VS Code');
  });
});
