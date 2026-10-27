import type { FactoryConfig, FactoryGateId, FactoryPreset, FactoryPresetPatch, FactoryStageId } from '../../../../../shared/api';

export const GATE_IDS: FactoryGateId[] = ['spec', 'plan', 'prePr', 'merge'];

/** The preset a config matches (its gates, mode and Approver settings), else 'custom'. */
export function matchingPreset(c: FactoryConfig, presets: Record<string, FactoryPresetPatch>): FactoryPreset {
  for (const [id, p] of Object.entries(presets)) {
    const approve = c.stages.find((s) => s.id === 'approve')?.on ?? false;
    if (p.mode && p.mode !== c.mode) continue;
    if (GATE_IDS.some((g) => p.gates[g] !== c.gates[g])) continue;
    if (p.approver.enabled !== c.approver.enabled || p.approver.mergeAction !== c.approver.mergeAction || p.approver.samplingPct !== c.approver.samplingPct) continue;
    if (p.approve !== approve) continue;
    return id as FactoryPreset;
  }
  return 'custom';
}

/** A preset applied to a config: its gates, mode and Approver settings; everything else kept. */
export function withPreset(c: FactoryConfig, id: Exclude<FactoryPreset, 'custom'>, presets: Record<string, FactoryPresetPatch>): FactoryConfig {
  const p = presets[id];
  const out: FactoryConfig = structuredClone(c);
  out.preset = id;
  if (p.mode) out.mode = p.mode;
  out.gates = { ...p.gates };
  out.approver = { ...out.approver, ...p.approver };
  const approve = out.stages.find((s) => s.id === 'approve');
  if (approve) approve.on = p.approve;
  return out;
}

/**
 * The board's columns for a config, in order (the server's rule): the stages that are on, with
 * each gate that isn't off where it guards: spec before planning, plan after it, pre-PR before
 * the PR, merge before merging.
 */
export function pipelineSteps(c: FactoryConfig): ({ kind: 'stage'; id: FactoryStageId } | { kind: 'gate'; id: FactoryGateId })[] {
  const out: ({ kind: 'stage'; id: FactoryStageId } | { kind: 'gate'; id: FactoryGateId })[] = [];
  const gate = (id: FactoryGateId) => { if (c.gates[id] !== 'off') out.push({ kind: 'gate', id }); };
  let spec = false, prePr = false, merge = false;
  for (const s of c.stages.filter((x) => x.on)) {
    if (!spec && (s.id === 'plan' || s.id === 'build')) { gate('spec'); spec = true; }
    if (!prePr && s.id === 'pr') { gate('prePr'); prePr = true; }
    if (!merge && s.id === 'merge') { gate('merge'); merge = true; }
    out.push({ kind: 'stage', id: s.id });
    if (s.id === 'plan') gate('plan');
  }
  if (!spec) gate('spec');
  if (!prePr) gate('prePr');
  if (!merge) gate('merge');
  return out;
}

/** "a, b,, c" or one per line → ['a', 'b', 'c'] (no duplicates). */
export function splitList(text: string): string[] {
  return [...new Set(String(text || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];
}

/** A number field's value: null when empty or not a number. */
export function numOrNull(v: unknown): number | null {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** How long a step took (or has been going, when it hasn't ended): "45s", "13m", "2h 5m", "3d 4h"; '' without a start. */
export function duration(start: string | null, end: string | null, now = Date.now()): string {
  if (!start) return '';
  const ms = (end ? Date.parse(end) : now) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
