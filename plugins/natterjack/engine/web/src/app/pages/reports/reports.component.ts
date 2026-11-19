import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service';
import { compact } from '../../core/palette';
import { relTime } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';

/** engine server/src/usage-summary.ts, as the router keeps it. */
interface SummaryDay { date: string; runs: number; succeeded: number; failed: number; tokens: number; costUsd: number; sessions: number }
interface UsageSummary {
  version: number;
  totals: { runs: number; rated: number; good: number };
  lastRunAt: string | null;
  days: SummaryDay[];
  presets: { id: string; runs: number }[];
  skills: { name: string; runs: number }[];
  weeklyLimitPct: number | null;
}
/** router/src/usage.ts usageReport() */
interface PersonRow {
  email: string;
  hasDashboard: boolean;
  running: boolean | null;
  lastSeen: string | null;
  activeDays7: number;
  activeDays30: number;
  collectedAt: string | null;
  summary: UsageSummary | null;
}
interface UsageReportResponse { generatedAt: string; people: PersonRow[]; collectEveryMinutes: number; kept: 'disk' | 'memory' }

interface Row extends PersonRow {
  runs30: number;
  failed30: number;
  tokens30: number;
  cost30: number;
  top: string;
  goodPct: number | null;
}

/**
 * Admins' Reports: how much each person uses their hosted dashboard. The data is the
 * router's (GET /_router/admin/usage), never this dashboard's own: the router collects a
 * totals-only summary from everyone's dashboard. Shown in the nav only when /_router/me
 * says you're an admin (ROUTER_ADMINS); the router refuses everyone else anyway.
 */
@Component({
  selector: 'dash-reports',
  imports: [PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './reports.component.scss',
  template: `
    <dash-page-header eyebrow="Admin" title="Reports" sub="How much each person uses their hosted dashboard, over the last 30 days. Totals only: nobody's prompts or results are collected.">
      <button class="btn ghost sm" (click)="load(true)" [disabled]="busy()">{{ busy() ? 'Collecting…' : 'Collect now' }}</button>
    </dash-page-header>

    @if (error()) { <div class="panel"><div class="panel-b empty">{{ error() }}</div></div> }
    @else if (!report()) { <div class="panel"><div class="panel-b empty">Loading…</div></div> }
    @else {
      <div class="stats">
        <div class="stat-card"><div class="k">People</div><div class="v">{{ rows().length }}</div><div class="extra">with a hosted dashboard</div></div>
        <div class="stat-card"><div class="k">Active this week</div><div class="v">{{ activeWeek() }}<small>/ {{ rows().length }}</small></div><div class="extra">opened it on at least one day</div></div>
        <div class="stat-card"><div class="k">Runs · 30 days</div><div class="v">{{ fmt(sum('runs30')) }}</div><div class="extra">{{ fmt(sum('failed30')) }} failed</div></div>
        <div class="stat-card"><div class="k">Tokens · 30 days</div><div class="v">{{ fmt(sum('tokens30')) }}</div><div class="extra">{{ money(sum('cost30')) }} API-equivalent</div></div>
      </div>

      <div class="panel">
        <div class="panel-h"><h2>Usage by person</h2><span class="ty">collected every {{ report()!.collectEveryMinutes }} min{{ report()!.kept === 'memory' ? ' · kept in memory only (set ROUTER_DATA_DIR)' : '' }}</span></div>
        <div class="panel-b flush">
          <table class="tbl">
            <thead><tr>
              <th>Person</th><th>Last opened</th><th class="num">Days · 7</th><th class="num">Days · 30</th>
              <th class="num">Runs</th><th class="num">Failed</th><th class="num">Tokens</th><th class="num" title="What the same usage would cost at API prices; not a bill on a subscription">API-equiv.</th>
              <th class="num" title="Share of rated runs marked good">Good</th><th class="num" title="The weekly plan limit's last reading">Week limit</th><th>Most used</th><th>Figures from</th>
            </tr></thead>
            <tbody>
              @for (r of rows(); track r.email) {
                <tr [class.idle]="!r.activeDays7">
                  <td class="who">{{ r.email }}@if (r.running === false) { <span class="tag">stopped</span> }</td>
                  <td>{{ r.lastSeen ? rel(r.lastSeen) : 'never' }}</td>
                  <td class="num">{{ r.activeDays7 }}</td>
                  <td class="num">{{ r.activeDays30 }}</td>
                  <td class="num">{{ r.summary ? r.runs30 : '—' }}</td>
                  <td class="num">{{ r.summary ? r.failed30 : '—' }}</td>
                  <td class="num">{{ r.summary ? fmt(r.tokens30) : '—' }}</td>
                  <td class="num">{{ r.summary ? money(r.cost30) : '—' }}</td>
                  <td class="num">{{ r.goodPct == null ? '—' : r.goodPct + '%' }}</td>
                  <td class="num">{{ r.summary?.weeklyLimitPct == null ? '—' : r.summary!.weeklyLimitPct + '%' }}</td>
                  <td class="top">{{ r.top || '—' }}</td>
                  <td class="ty">{{ r.collectedAt ? rel(r.collectedAt) : 'not collected yet' }}</td>
                </tr>
              } @empty {
                <tr><td colspan="12" class="empty">Nobody has a hosted dashboard yet.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </div>
      <p class="foot ty">Figures come from each dashboard while it runs, and once more before it stops for being idle, so a stopped dashboard shows its last figures. "Last opened" and days are counted by the router (UTC days).</p>
    }
  `,
})
export class ReportsComponent implements OnInit {
  private readonly api = inject(ApiService);
  readonly report = signal<UsageReportResponse | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  readonly rows = computed<Row[]>(() => (this.report()?.people || []).filter((p) => p.hasDashboard || p.summary).map((p) => {
    const days = p.summary?.days || [];
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
  }).sort((a, b) => b.activeDays30 - a.activeDays30 || b.runs30 - a.runs30 || a.email.localeCompare(b.email)));
  readonly activeWeek = computed(() => this.rows().filter((r) => r.activeDays7 > 0).length);

  ngOnInit(): void { void this.load(false); }

  async load(collect: boolean): Promise<void> {
    this.busy.set(true);
    try {
      this.report.set(await this.api.get<UsageReportResponse>(`/_router/admin/usage${collect ? '?refresh=1' : ''}`));
      this.error.set(null);
    } catch (e) {
      const status = (e as { status?: number }).status;
      this.error.set(status === 403 ? 'Only admins can see this report.' : status === 404 ? 'Reports need the hosted router (this dashboard isn\'t behind one).' : (e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  sum(k: 'runs30' | 'failed30' | 'tokens30' | 'cost30'): number { return this.rows().reduce((s, r) => s + r[k], 0); }
  fmt(n: number): string { return compact(n); }
  money(n: number): string { return `$${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2)}`; }
  rel(t: string): string { return relTime(t); }
}
