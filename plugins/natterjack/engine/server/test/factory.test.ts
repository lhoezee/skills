// factory.ts: factory.json defaults, presets and saving; manifests; the pipeline's order; placing items on the board.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyPreset, boardColumns, buildBoard, defaultFactoryConfig, factoryConfigProblems, factoryConfigState, normalizeFactoryConfig,
  normalizeManifest, pipeline, placeItem, readManifests, saveFactoryConfig,
} from "../src/factory.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "factory-"));

test("no factory.json: the Supervised preset, off", () => {
  const s = factoryConfigState(true, tmp());
  assert.equal(s.exists, false);
  assert.equal(s.config.enabled, false);
  assert.equal(s.config.preset, "supervised");
  assert.deepEqual(Object.values(s.config.gates), ["human", "human", "human", "human"]);
  assert.ok(s.config.security.scanners.some((x) => x.command.startsWith("npm audit")));
  assert.equal(s.presets["lights-out"].mode, "autonomous");
});

test("normalize keeps good values, drops bad ones and fills the rest", () => {
  const c = normalizeFactoryConfig({
    enabled: true, preset: "nope", mode: "autonomous",
    intake: { states: ["Ready", "Ready", 3, " "], labels: ["factory"] },
    limits: { wip: 0, itemBudgetUsd: "12.5", dayBudgetUsd: -4, itemHours: 2 },
    stages: [{ id: "build" }, { id: "qa", on: true, agent: "codex", model: " gpt-5 " }, { id: "bogus" }, { id: "build", on: false }],
    security: { scanners: [{ command: "  osv-scanner -r .  ", failOn: "urgent" }, { name: "x" }], failOn: "medium" },
    gates: { plan: "approver", merge: "sometimes" },
    approver: { enabled: true, samplingPct: 250, mergeMethod: "rebase" },
  });
  assert.equal(c.preset, "custom");
  assert.deepEqual(c.intake, { states: ["Ready"], labels: ["factory"] });
  assert.deepEqual(c.limits, { wip: 1, itemBudgetUsd: 12.5, dayBudgetUsd: null, itemHours: 2 });
  assert.deepEqual(c.stages.slice(0, 3).map((s) => [s.id, s.on, s.agent, s.model]), [["build", true, null, null], ["qa", true, "codex", "gpt-5"], ["align", false, null, null]]);
  assert.equal(c.stages.length, 10);
  assert.deepEqual(c.security.scanners, [{ name: "osv-scanner -r", command: "osv-scanner -r .", when: null, failOn: "high" }]);
  assert.deepEqual(c.gates, { spec: "human", plan: "approver", prePr: "human", merge: "human" });
  assert.equal(c.approver.samplingPct, 100);
  assert.equal(c.approver.mergeMethod, "rebase");
});

test("presets set gates, mode and the Approver, and keep the rest", () => {
  const base = { ...defaultFactoryConfig(), requiredChecks: ["build"] };
  const lo = applyPreset(base, "lights-out");
  assert.equal(lo.mode, "autonomous");
  assert.equal(lo.gates.spec, "off");
  assert.equal(lo.approver.mergeAction, "auto-merge");
  assert.equal(lo.stages.find((s) => s.id === "approve")!.on, true);
  assert.deepEqual(lo.requiredChecks, ["build"]);
  assert.deepEqual(factoryConfigProblems(lo), []);
  const sup = applyPreset(lo, "supervised");
  assert.equal(sup.approver.enabled, false);
  assert.equal(sup.stages.find((s) => s.id === "approve")!.on, false);
});

test("problems: build off, a gate on the Approver while it's off, merging without the merge gate", () => {
  const c = defaultFactoryConfig();
  c.stages.find((s) => s.id === "build")!.on = false;
  c.gates.plan = "approver";
  c.approver.mergeAction = "merge";
  assert.equal(factoryConfigProblems(c).length, 3);
});

test("save writes factory.json and refuses a stale edit or a config with problems", () => {
  const dir = tmp();
  const first = saveFactoryConfig({ config: { ...defaultFactoryConfig(), enabled: true }, mtimeMs: null }, dir);
  assert.equal(first.exists, true);
  assert.equal(first.config.enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "factory.json"), "utf-8")).enabled, true);
  assert.throws(() => saveFactoryConfig({ config: first.config, mtimeMs: null }, dir), (e: any) => e.status === 409);
  const bad = { ...first.config, gates: { ...first.config.gates, merge: "approver" } };
  assert.throws(() => saveFactoryConfig({ config: bad, mtimeMs: first.mtimeMs }, dir), (e: any) => e.status === 400 && /Approver is off/.test(e.message));
  assert.equal(saveFactoryConfig({ config: { ...first.config, mode: "autonomous" }, mtimeMs: first.mtimeMs }, dir).config.mode, "autonomous");
});

test("the pipeline places each gate where it guards, and leaves out gates that are off", () => {
  const ids = (c = defaultFactoryConfig()) => pipeline(c).map((s) => (s.kind === "gate" ? `gate:${s.id}` : s.id));
  assert.deepEqual(ids(), ["gate:spec", "plan", "gate:plan", "build", "review", "security", "guide", "gate:prePr", "pr", "gate:merge", "merge"]);
  const lo = applyPreset(defaultFactoryConfig(), "lights-out");
  assert.deepEqual(ids(lo), ["plan", "gate:plan", "build", "review", "security", "guide", "gate:prePr", "pr", "approve", "gate:merge", "merge"]);
  const noPr = defaultFactoryConfig();
  noPr.stages.filter((s) => s.id === "pr" || s.id === "merge").forEach((s) => (s.on = false));
  assert.deepEqual(ids(noPr).slice(-2), ["gate:prePr", "gate:merge"]);
  const cols = boardColumns(defaultFactoryConfig());
  assert.deepEqual([cols[0].id, cols.at(-1)!.id, cols[1].label], ["queued", "done", "Spec gate"]);
});

const at = "2026-10-27T10:00:00.000Z";
function manifest(over: any = {}) {
  return normalizeManifest({ ticket: "ENG-1", title: "Retries", startedAt: at, updatedAt: at, repos: ["api", "web"], stages: [], gates: [], prs: [], ...over })!;
}

test("placeItem: queued, moving, failing, waiting on a gate, skipped steps, done", () => {
  const steps = pipeline(defaultFactoryConfig());
  const gate = (id: string, decision: string, extra = {}) => ({ id, mode: "human", decision, at, ...extra });
  const st = (id: string, status: string, repo = "api") => ({ id, repo, status });
  assert.deepEqual(placeItem(manifest(), steps), { column: "queued", state: "idle", reason: null });
  assert.deepEqual(placeItem(manifest({ gates: [gate("spec", "pending")] }), steps), { column: "gate:spec", state: "waiting", reason: "Waiting on you" });
  const planned = { gates: [gate("spec", "approved"), gate("plan", "approved")], stages: [st("plan", "done")] };
  assert.deepEqual(placeItem(manifest({ ...planned, stages: [...planned.stages, st("build", "running")] }), steps).column, "build");
  // A later write for the same repo wins: failed, then running again.
  const retried = manifest({ ...planned, stages: [...planned.stages, st("build", "failed"), st("build", "running")] });
  assert.equal(placeItem(retried, steps).state, "moving");
  assert.deepEqual(placeItem(manifest({ ...planned, stages: [...planned.stages, st("build", "done"), st("build", "failed", "web")] }), steps), { column: "build", state: "failing", reason: "Building failed" });
  // Security and guide never ran but the PR did: they count as skipped.
  const atPr = manifest({ ...planned, stages: [...planned.stages, st("build", "done"), st("review", "done"), st("pr", "done")], gates: [...planned.gates, gate("prePr", "approved"), gate("merge", "pending", { mode: "approver", risk: "low" })] });
  assert.deepEqual(placeItem(atPr, steps), { column: "gate:merge", state: "waiting", reason: "Waiting on the Approver" });
  assert.equal(placeItem(manifest({ gates: [gate("spec", "rejected", { by: "kim" })] }), steps).reason, "Rejected by kim");
  assert.equal(placeItem(manifest({ done: true }), steps).column, "done");
  assert.equal(placeItem(manifest({ stages: [st("plan", "done")], prs: [{ url: "https://x/1", state: "merged" }] }), steps).column, "done");
});

test("buildBoard joins runs by ticket and rolls up repos, cost, risk and WIP", () => {
  const cfg = { ...defaultFactoryConfig(), enabled: true };
  const m = manifest({
    gates: [{ id: "spec", decision: "approved", at }, { id: "plan", decision: "approved", at, risk: "medium", rationale: "Touches auth" }],
    stages: [{ id: "plan", status: "done" }, { id: "build", repo: "api", status: "done", agent: "claude" }, { id: "review", repo: "api", status: "running" }, { id: "build", repo: "web", status: "running" }],
  });
  const runs = [
    { id: "r1", ticket: "eng-1", status: "succeeded" as const, costUsd: 1.234, startedAt: "2026-10-27T09:00:00Z", agent: "claude", model: "opus" },
    { id: "r2", ticket: "ENG-1", status: "waiting" as const, costUsd: 2, startedAt: "2026-10-27T11:00:00Z", agent: "codex", model: null },
    { id: "r3", ticket: "ENG-2", status: "running" as const, costUsd: 9, startedAt: at, agent: "claude", model: null },
  ];
  const b = buildBoard(cfg, true, [m, manifest({ ticket: "ENG-3" })], runs);
  const [item, queued] = b.items;
  assert.equal(b.enabled, true);
  assert.deepEqual([item.column, item.state, item.reason], ["build", "waiting", "Question waiting"]);
  assert.deepEqual(item.runIds, ["r2", "r1"]);
  assert.equal(item.costUsd, 3.23);
  assert.equal(item.agent, "codex");
  assert.deepEqual(item.repos, [{ repo: "api", status: "running", stage: "review" }, { repo: "web", status: "running", stage: "build" }]);
  assert.deepEqual(item.risk, { level: "medium", rationale: "Touches auth" });
  assert.equal(queued.column, "queued");
  assert.deepEqual(b.wip, { inFlight: 1, limit: 3 });
  assert.equal(buildBoard(cfg, false, [], []).enabled, false);
});

test("readManifests reads the folder newest first and reports files it can't read", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "ENG-1.json"), JSON.stringify({ ticket: "ENG-1", updatedAt: "2026-10-01T00:00:00Z" }));
  fs.writeFileSync(path.join(dir, "ENG-2.json"), JSON.stringify({ ticket: "ENG-2", updatedAt: "2026-10-02T00:00:00Z" }));
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  fs.writeFileSync(path.join(dir, "other.json"), "{}");
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  const { manifests, errors } = readManifests(dir);
  assert.deepEqual(manifests.map((m) => m.ticket), ["ENG-2", "ENG-1"]);
  assert.equal(errors.length, 2);
  assert.deepEqual(readManifests(path.join(dir, "missing")), { manifests: [], errors: [] });
});
