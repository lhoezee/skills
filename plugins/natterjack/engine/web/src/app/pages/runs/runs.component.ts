import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, input, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { RunMeta } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { LaunchService } from '../../core/launch.service';
import { SmallScreenService } from '../../core/small-screen';
import { dur, lsGet, lsSet, pct } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { RunRowComponent } from '../../shared/run-row.component';
import { filterRuns, MANUAL_RUNS, routineOf, toReview, unrated } from '../../shared/run-status';
import { QuestionDock } from './question-dock';
import { RunDetailComponent } from './run-detail.component';
import { RunQuestionsComponent } from './run-questions.component';
import { TerminalSessionsComponent } from './terminal-sessions.component';

/**
 * Status chips. Selecting several shows runs matching any of them; none selected = all. `data`
 * gives "Needs answer" (and so Focus) the same rule as the Activity waiting pill.
 */
const CHIPS: { key: string; label: string; test: (r: RunMeta, data: DataService) => boolean }[] = [
  { key: 'flagged', label: 'Flagged', test: (r) => !!r.flagged },
  { key: 'running', label: 'Running', test: (r) => r.status === 'running' },
  { key: 'waiting', label: 'Needs answer', test: (r, data) => data.needsAnswer(r) },
  { key: 'review', label: 'To review', test: (r) => toReview(r) },
  { key: 'succeeded', label: 'Done', test: (r) => r.status === 'succeeded' },
  { key: 'failed', label: 'Failed', test: (r) => r.status === 'failed' || r.status === 'interrupted' },
  { key: 'cancelled', label: 'Cancelled', test: (r) => r.status === 'cancelled' },
  { key: 'handedOff', label: 'In terminal', test: (r) => r.status === 'handedOff' },
  { key: 'unrated', label: 'Unrated', test: (r) => unrated(r) },
];
const FOCUS = ['flagged', 'running', 'waiting', 'review'];
const KEYS = new Set(CHIPS.map((c) => c.key));
/** The left column's widths (localStorage) and limits; SPLIT_PX is .split's width in runs.component.scss. */
const HISTORY_W_KEY = 'dash.runs.historyWidth';
const ASKING_W_KEY = 'dash.runs.questionsShare';
const HISTORY_W_DEFAULT = 400;
const HISTORY_OPEN_KEY = 'dash.runs.historyOpenWhileAsking';
/** The last "Started by" choice, used when the URL has no ?routine=. */
const ROUTINE_KEY = 'dash.runs.routine';
const ASKING_W_DEFAULT = 0.5;
const LEFT_MIN_PX = 280;
const RUN_MIN_PX = 420;
const SPLIT_PX = 16;
const parse = (s: string | null | undefined) => new Set(String(s || '').split(',').map((x) => x.trim()).filter((x) => KEYS.has(x)));

@Component({
  selector: 'dash-runs',
  imports: [RouterLink, PageHeaderComponent, RunRowComponent, RunDetailComponent, RunQuestionsComponent, TerminalSessionsComponent],
  providers: [QuestionDock],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './runs.component.scss',
  template: `
    <dash-page-header eyebrow="Activity" title="Activity" sub="Everything the agents have worked on here: live transcript, subagents, questions it asks you, and replies.">
      @if (!api.hosted()) { <button class="btn sm" type="button" [class.on]="fromTerminal()" (click)="fromTerminal.set(!fromTerminal())" title="Open a Claude Code session you started in a terminal here">From terminal</button> }
      <button class="btn primary sm" type="button" (click)="newSession()" title="Start a new run in its own session">New session</button>
    </dash-page-header>
    <!-- Small screens show one thing at a time: the list, or the open run with "All runs" back to the list. -->
    <div class="runs-layout" #layout [class.has-run]="!!selectedId()" [class.asking]="!!dock.host()" [style.--left-w]="leftWidth()">
      <div class="col">
        @if (dock.host(); as h) {
          <div class="panel q-panel">
            <div class="panel-h"><h2>Needs your answer</h2><span class="shown" [title]="h.run().label || ''">{{ h.run().label }}</span></div>
            <dash-run-questions [host]="h" [docked]="true" />
          </div>
        }
        @if (fromTerminal()) { <dash-terminal-sessions (closed)="fromTerminal.set(false)" /> }
        @let folded = !!dock.host() && !historyOpen();
        <div class="panel history" [class.folded]="folded">
          @if (dock.host()) {
            <button type="button" class="panel-h fold" [attr.aria-expanded]="!folded" (click)="toggleHistory()"
              [title]="folded ? 'Show the runs, to open another one' : 'Hide the runs, to give the questions the room'">
              <h2>History</h2>
              @if (waitingOthers(); as n) { <span class="n-hot" title="Other runs waiting for your answer">{{ n }} waiting</span> }
              <span class="shown">{{ list().length }} of {{ data.activityRuns().length }}</span>
              <span class="caret">{{ folded ? '▸' : '▾' }}</span>
            </button>
          } @else {
            <div class="panel-h"><h2>History</h2><span class="shown">{{ list().length }} of {{ data.activityRuns().length }}</span></div>
          }
          @if (!folded) {
          <div class="chips" role="group" aria-label="Filter runs by status">
            <button type="button" class="chip preset" [class.on]="isFocus()" (click)="setFilter(isFocus() ? [] : focus)" title="Only what needs you now: flagged, running, waiting for an answer, and finished in the last day but not rated yet">Focus</button>
            <button type="button" class="chip" [class.on]="!selected().size" (click)="setFilter([])">All</button>
            <span class="sep"></span>
            @for (c of chips(); track c.key) {
              <button type="button" class="chip" [class.on]="selected().has(c.key)" [attr.aria-pressed]="selected().has(c.key)" (click)="toggle(c.key)">
                {{ c.label }} <span class="n" [class.hot]="c.hot">{{ c.count }}</span>
              </button>
            }
          </div>
          <div class="list-filters">
            <input type="search" class="run-search" placeholder="Search titles…" aria-label="Search runs by title or ticket"
              [value]="q()" (input)="setQuery($any($event.target).value)" (keydown.escape)="setQuery('')" />
            <label for="routine-filter">Started by</label>
            <select id="routine-filter" [value]="routine()" (change)="setRoutine($any($event.target).value)">
              <option value="" [selected]="!routine()">All runs</option>
              <option [value]="manual" [selected]="routine() === manual">You (not a routine)</option>
              @if (routineOptions().length) {
                <optgroup label="Routines">
                  @for (o of routineOptions(); track o.id) { <option [value]="o.id" [selected]="o.id === routine()">{{ o.label }}</option> }
                </optgroup>
              }
            </select>
          </div>
          <div class="panel-b runs-list">
            @for (r of list(); track r.id) { <dash-run-row [run]="r" [selected]="r.id === selectedId()" [keepQuery]="true" /> }
            @empty { <div class="empty">{{ q() || routine() ? 'No runs match.' : selected().size ? 'Nothing here right now.' : 'No runs yet.' }}</div> }
          </div>
          }
        </div>
        @if (!dock.host()) {
        <div class="panel">
          <div class="panel-h"><h2>Track record</h2></div>
          @if (trust().length) {
            <table class="trust-table">
              <tr><th>Preset</th><th>Runs</th><th>OK</th><th>Good</th><th>Avg time</th></tr>
              @for (t of trust(); track t.id) {
                <tr><td>{{ t.label }}</td><td>{{ t.runs }}</td><td>{{ t.ok }}</td><td>{{ t.good }}</td><td>{{ t.avg }}</td></tr>
              }
            </table>
          } @else { <div class="empty">No finished runs yet.</div> }
          <div class="hint">Verdicts are yours: mark each finished run <b>good</b> or <b>needed fix</b>. A preset earns more autonomy once it has a real record.</div>
        </div>
        }
      </div>
      <div class="split" role="separator" aria-orientation="vertical" aria-label="Resize the left column" tabindex="0"
        [attr.aria-valuenow]="split().now" [attr.aria-valuemin]="split().min" [attr.aria-valuemax]="split().max" [attr.aria-valuetext]="split().now + '% of the page'"
        title="Drag to resize · double-click to reset" (pointerdown)="dragStart($event)" (dblclick)="resetWidth()" (keydown)="onSplitKey($event)"></div>
      <div class="detail-col">
        @if (selectedId(); as id) {
          <a class="back" routerLink="/runs" queryParamsHandling="preserve">← All runs</a>
          <dash-run-detail [runId]="id" />
        } @else {
          <div class="panel"><div class="empty" style="padding:3rem">Select a run.</div></div>
        }
      </div>
    </div>
  `,
})
export class RunsComponent {
  readonly data = inject(DataService);
  /** The open run's questions, when they're docked in the left column (question-dock.ts). */
  readonly dock = inject(QuestionDock);
  private readonly layout = viewChild<ElementRef<HTMLElement>>('layout');
  /**
   * The left column's width, dragged with the handle beside it. Kept per mode: History in px
   * (default 400), the questions as a share of the page (default half), so each opens as you left it.
   */
  readonly historyPx = signal(Number(lsGet(HISTORY_W_KEY, '')) || HISTORY_W_DEFAULT);
  readonly askingShare = signal(Number(lsGet(ASKING_W_KEY, '')) || ASKING_W_DEFAULT);
  /**
   * While questions are docked, History sits folded under them (one click to open, so another run
   * is always reachable). Your last choice is kept.
   */
  readonly historyOpen = signal(lsGet(HISTORY_OPEN_KEY, '') === '1');
  /** Runs other than the open one waiting for your answer: shown on the folded History bar. */
  readonly waitingOthers = computed(() =>
    this.data.activityRuns().filter((r) => r.id !== this.selectedId() && this.data.needsAnswer(r)).length);
  /** The page's width, for the separator's value (a ResizeObserver in the constructor). */
  private readonly layoutW = signal(0);
  /**
   * The separator's value for assistive tech: the left column's rendered share of the page, in %,
   * clamped the way the CSS track is (LEFT_MIN_PX to the width less the run's minimum).
   */
  readonly split = computed(() => {
    const w = this.layoutW();
    if (!w) return { now: 0, min: 0, max: 100 };
    const hi = Math.max(LEFT_MIN_PX, w - SPLIT_PX - RUN_MIN_PX);
    const want = this.dock.host() ? this.askingShare() * w : this.historyPx();
    const pctOf = (px: number) => Math.round((px / w) * 100);
    return { now: pctOf(Math.max(LEFT_MIN_PX, Math.min(want, hi))), min: pctOf(LEFT_MIN_PX), max: pctOf(hi) };
  });
  toggleHistory(): void {
    this.historyOpen.set(!this.historyOpen());
    lsSet(HISTORY_OPEN_KEY, this.historyOpen() ? '1' : '0');
  }
  readonly leftWidth = computed(() => this.dock.host() ? (this.askingShare() * 100).toFixed(2) + '%' : this.historyPx() + 'px');
  readonly api = inject(ApiService);
  /** The "From terminal" list is open. */
  readonly fromTerminal = signal(false);
  private readonly launch = inject(LaunchService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  /** Phone-sized: the list and the open run take turns (runs.component.scss). */
  private readonly small = inject(SmallScreenService).matches;
  /** Route param (/runs/:id), bound via withComponentInputBinding. */
  readonly id = input<string | undefined>(undefined);
  readonly focus = FOCUS;
  /** Selected status chips: from the URL (?status=running,waiting) if present, else the last choice. */
  readonly selected = signal<Set<string>>(parse(this.route.snapshot.queryParamMap.get('status') ?? lsGet('dash.runs.status', '')));
  readonly isFocus = computed(() => this.selected().size === FOCUS.length && FOCUS.every((k) => this.selected().has(k)));
  readonly chips = computed(() => CHIPS.map((c) => {
    const count = this.scoped().filter((r) => c.test(r, this.data)).length;
    return { key: c.key, label: c.label, count, hot: (c.key === 'waiting' || c.key === 'running' || c.key === 'flagged') && count > 0 };
  }));

  /**
   * "Started by": one routine's runs (?routine=<id>, also set by a routine's History link on Loops),
   * MANUAL_RUNS for the runs no routine started, or empty for all. Without ?routine= in the URL, the last choice.
   */
  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  readonly manual = MANUAL_RUNS;
  readonly routine = computed(() => this.query().get('routine') ?? lsGet(ROUTINE_KEY, ''));
  /** The title search (?q=). Set straight away on typing; the URL follows. */
  readonly q = signal(this.route.snapshot.queryParamMap.get('q') || '');
  /** The routines to pick from: every one defined, plus any that only exist in the history. */
  readonly routineOptions = computed(() => {
    const byId = new Map<string, string>();
    for (const r of this.data.routines() || []) byId.set(r.id, r.label || r.id);
    for (const r of this.data.activityRuns()) { const id = routineOf(r); if (id && !byId.has(id)) byId.set(id, id); }
    // The filter in the URL always has an option, even for a deleted routine with no runs left in the feed.
    const active = this.routine();
    if (active && active !== MANUAL_RUNS && !byId.has(active)) byId.set(active, active);
    return [...byId].map(([id, label]) => ({ id, label }));
  });
  /** The runs the status chips count and filter: narrowed by "Started by" and the search. */
  private readonly scoped = computed(() => filterRuns(this.data.activityRuns(), { routine: this.routine(), q: this.q() }));

  readonly selectedId = computed(() => this.id() || null);
  readonly list = computed(() => {
    const sel = this.selected();
    if (!sel.size) return this.scoped();
    const tests = CHIPS.filter((c) => sel.has(c.key)).map((c) => c.test);
    const hits = this.scoped().filter((r) => tests.some((t) => t(r, this.data)));
    // In a filtered view, flagged runs come first (stable, so newest-first holds within each group).
    return [...hits.filter((r) => r.flagged), ...hits.filter((r) => !r.flagged)];
  });
  readonly trust = computed(() => {
    const stats = this.data.stats();
    const rows = (this.data.deck()?.presets || []).map((p) => ({ id: p.id, label: p.label, s: stats[p.id] }));
    if (stats['_adhoc']) rows.push({ id: '_adhoc', label: 'Ad-hoc', s: stats['_adhoc'] });
    return rows.filter((r) => r.s).map((r) => ({
      id: r.id, label: r.label, runs: r.s.runs, ok: pct(r.s.succeeded, r.s.runs),
      good: r.s.rated ? r.s.good + '/' + r.s.rated : '—', avg: dur(r.s.durationMs / r.s.runs),
    }));
  });

  constructor() {
    if (this.data.routines() === null) this.data.loadRoutines();
    effect((onCleanup) => {
      const el = this.layout()?.nativeElement;
      if (!el) return;
      const ro = new ResizeObserver(() => this.layoutW.set(el.getBoundingClientRect().width));
      ro.observe(el);
      onCleanup(() => ro.disconnect());
    });
    // Open the newest run when none is selected (replaceUrl so Back still works). Not on a small
    // screen: there the list and the run take turns, and /runs is the list ("All runs" goes back to it).
    // Decided once, at the screen size the page loaded with: rotating or resizing doesn't change it,
    // so turning a phone after "All runs" doesn't open a run again.
    const autoOpen = !untracked(this.small);
    effect(() => {
      if (this.id() || !autoOpen) return;
      const first = this.list()[0] || this.data.activityRuns()[0];
      if (first) this.router.navigate(['/runs', first.id], { replaceUrl: true, queryParamsHandling: 'preserve' });
    });
    // Small screens: a run opened from further down the list starts at its top (the router doesn't
    // restore scroll). Only on opening a run: "All runs" back to the list leaves the page where it is.
    effect(() => {
      if (this.selectedId() && untracked(this.small)) untracked(() => window.scrollTo({ top: 0 }));
    });
  }

  dragStart(e: PointerEvent): void {
    const el = this.layout()?.nativeElement;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const left = el.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => this.setWidth(ev.clientX - left);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      this.saveWidth();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  /** Arrow keys move the handle 24px (Shift: 96px); Home/End go to the narrowest and widest. */
  onSplitKey(e: KeyboardEvent): void {
    const step = e.shiftKey ? 96 : 24;
    const cur = this.currentPx();
    const to = e.key === 'ArrowLeft' ? cur - step : e.key === 'ArrowRight' ? cur + step : e.key === 'Home' ? 0 : e.key === 'End' ? Infinity : null;
    if (to === null) return;
    e.preventDefault();
    this.setWidth(to);
    this.saveWidth();
  }

  resetWidth(): void {
    if (this.dock.host()) this.askingShare.set(ASKING_W_DEFAULT); else this.historyPx.set(HISTORY_W_DEFAULT);
    this.saveWidth();
  }

  private currentPx(): number {
    const w = this.layout()?.nativeElement.getBoundingClientRect().width || 0;
    return this.dock.host() ? this.askingShare() * w : this.historyPx();
  }

  /** Clamped so both columns stay usable: the left at least 280px, the run at least 420px. */
  private setWidth(px: number): void {
    const w = this.layout()?.nativeElement.getBoundingClientRect().width || 0;
    if (!w) return;
    const clamped = Math.round(Math.max(LEFT_MIN_PX, Math.min(px, w - SPLIT_PX - RUN_MIN_PX)));
    if (this.dock.host()) this.askingShare.set(clamped / w); else this.historyPx.set(clamped);
  }

  private saveWidth(): void {
    lsSet(HISTORY_W_KEY, String(this.historyPx()));
    lsSet(ASKING_W_KEY, this.askingShare().toFixed(4));
  }

  /** The run dialog on an empty prompt, as from Home: a new run, not a reply to the open one. */
  newSession(): void { this.launch.open({ title: 'New session', prompt: '', focusPrompt: true }); }

  toggle(key: string): void {
    const s = new Set(this.selected());
    if (s.has(key)) s.delete(key); else s.add(key);
    this.setFilter([...s]);
  }

  /** Kept in localStorage too, for the next visit without ?routine=. */
  setRoutine(id: string): void {
    lsSet(ROUTINE_KEY, id);
    this.router.navigate([], { relativeTo: this.route, queryParams: { routine: id || null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  setQuery(q: string): void {
    this.q.set(q);
    this.router.navigate([], { relativeTo: this.route, queryParams: { q: q.trim() ? q : null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** Keeps the choice in localStorage and the URL (bookmarkable). The open run stays open even if filtered out. */
  setFilter(keys: string[]): void {
    const s = new Set(keys.filter((k) => KEYS.has(k)));
    this.selected.set(s);
    const csv = CHIPS.map((c) => c.key).filter((k) => s.has(k)).join(',');
    lsSet('dash.runs.status', csv);
    this.router.navigate([], { relativeTo: this.route, queryParams: { status: csv || null }, queryParamsHandling: 'merge', replaceUrl: true });
  }
}
