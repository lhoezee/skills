import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { RunMeta, TerminalSession, TerminalSessionsResponse } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { relTime } from '../../core/util';
import { entrypointLabel, sessionGroups } from '../../runs/terminal-sessions';

/**
 * "From terminal" on the Activity page: Claude Code sessions started in a terminal (or the
 * desktop app, an IDE) in this workspace or a folder chosen in Settings, to open here as a run
 * (server/src/sessions.ts). Another folder's can also be moved into this workspace.
 */
@Component({
  selector: 'dash-terminal-sessions',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .ts-list { max-height: 360px; overflow-y: auto; }
    .ts-group { padding: 6px 12px 4px; font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--text-muted); background: var(--surface-2, transparent); border-bottom: 1px solid var(--line-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ts-row { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); }
    .ts-main { flex: 1; min-width: 0; }
    .ts-label { font-size: 13px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ts-sub { font-size: 11.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ts-hint { padding: 8px 12px 10px; font-size: 12px; color: var(--text-muted); border-top: 1px solid var(--line-soft); }
  `],
  template: `
    <div class="panel">
      <div class="panel-h">
        <h2>Sessions from a terminal</h2>
        <button class="btn sm" type="button" (click)="closed.emit()">Close</button>
      </div>
      <div class="ts-list">
        @if (loading()) { <div class="empty">Looking for sessions…</div> }
        @else if (error()) { <div class="empty">{{ error() }}</div> }
        @else {
          @for (g of groups(); track g.folder) {
            @if (groups().length > 1 || g.folder) {
              <div class="ts-group" [title]="g.folder || ''">{{ g.folder ? g.folder + ' · outside this workspace' : 'This workspace' }}</div>
            }
            @for (s of g.sessions; track s.sessionId) {
              <div class="ts-row">
                <div class="ts-main">
                  <div class="ts-label" [title]="s.label">{{ s.label }}
                    @if (s.live) { <span class="tag amber" title="Written to in the last 2 minutes: probably still open. You can open it here and follow it, and reply once it's quiet.">open now</span> }
                  </div>
                  <div class="ts-sub" [title]="s.cwd">{{ !s.folder && s.workspace !== 'main' ? s.workspace + ' · ' : '' }}{{ s.branch ? s.branch + ' · ' : '' }}{{ entrypointLabel(s.entrypoint) ? entrypointLabel(s.entrypoint) + ' · ' : '' }}{{ relTime(s.lastActivityAt) }}</div>
                </div>
                @if (s.movedTo) {
                  <a class="btn sm" [routerLink]="['/runs', s.movedTo]" title="It was moved into this workspace already: open that run">Moved</a>
                } @else if (s.folder) {
                  <button class="btn sm" type="button" [disabled]="!!busy()" (click)="move(s)"
                    title="Copy this conversation into this workspace and carry it on here (the original stays in its folder). Then it can go to the hosted dashboard too.">{{ busy() === s.sessionId + ':move' ? 'Moving…' : 'Move here' }}</button>
                }
                <button class="btn primary sm" type="button" [disabled]="!!busy()" (click)="open(s)"
                  [title]="s.folder ? 'Follow and reply to it here; it keeps working in ' + s.folder : 'Follow and reply to it here'">{{ busy() === s.sessionId + ':open' ? 'Opening…' : 'Open here' }}</button>
              </div>
            }
          } @empty { <div class="empty">No sessions from the last 30 days. Sessions started with <code>claude</code> in this workspace or its worktrees show here.</div> }
        }
      </div>
      <div class="ts-hint">
        <b>Open here</b> carries the conversation on where it is: replies resume it, and what you type in the terminal shows up here (exit it there before replying here).
        <b>Move here</b> copies another folder's conversation into this workspace to carry on in, the original staying as it was.
        With Remote control on, these show on your hosted dashboard too. Other folders: <a routerLink="/settings">Settings</a>.
      </div>
    </div>
  `,
})
export class TerminalSessionsComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  readonly closed = output<void>();
  readonly sessions = signal<TerminalSession[]>([]);
  readonly groups = computed(() => sessionGroups(this.sessions()));
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  /** What's under way: "<sessionId>:open" or "<sessionId>:move". */
  readonly busy = signal<string | null>(null);
  readonly relTime = relTime;
  readonly entrypointLabel = entrypointLabel;

  constructor() { this.load(); }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.sessions.set((await this.api.get<TerminalSessionsResponse>('/api/sessions')).sessions);
      this.error.set(null);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  open(s: TerminalSession): Promise<void> { return this.act(s, 'open', '/api/sessions/adopt'); }
  move(s: TerminalSession): Promise<void> { return this.act(s, 'move', '/api/sessions/move'); }

  private async act(s: TerminalSession, kind: 'open' | 'move', url: string): Promise<void> {
    this.busy.set(s.sessionId + ':' + kind);
    try {
      const { run } = await this.api.post<{ run: RunMeta }>(url, { sessionId: s.sessionId });
      // Opened, it's a run now; moved, the original stays listed (it can still be opened where it is), marked moved.
      if (kind === 'open') this.sessions.update((list) => list.filter((x) => x.sessionId !== s.sessionId));
      else this.sessions.update((list) => list.map((x) => (x.sessionId === s.sessionId ? { ...x, movedTo: run.id } : x)));
      this.router.navigate(['/runs', run.id], { queryParamsHandling: 'preserve' });
    } catch (e) {
      this.toast.error((e as Error).message);
    } finally {
      this.busy.set(null);
    }
  }
}
