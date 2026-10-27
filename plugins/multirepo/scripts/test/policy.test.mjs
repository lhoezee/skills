// The factory policy driving the pipeline: factory.mjs decide / wip, and security-scan.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decide, stageOn, wip } from "../factory.mjs";
import { changedFiles, runScanner, securityScan } from "../security-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const on = (gates, extra = {}) => ({ enabled: true, gates, ...extra });
const spec = (score, level, minScore = null) => ({ score, level, readyAt: 80, needsWorkAt: 50, minScore });

test("decide: no policy on means the skill's own rules; off gates skip; merge always hands off", () => {
  assert.equal(decide(null, null, "plan").action, "own-rules");
  assert.equal(decide({ enabled: false, gates: { plan: "auto" } }, null, "plan").action, "own-rules");
  assert.equal(decide(on({ plan: "off" }), null, "plan").action, "skip");
  assert.equal(decide(on({ merge: "auto" }), null, "merge").action, "handoff");
  assert.throws(() => decide(on({}), null, "deploy"), /--gate must be/);
});

test("decide: a person's gate asks when the run can ask, else stops; the Approver's is a person's for now", () => {
  assert.equal(decide(on({ plan: "human" }), null, "plan").action, "ask");
  const auto = decide(on({ plan: "human" }), null, "plan", { run: "autonomous" });
  assert.equal(auto.action, "stop");
  assert.match(auto.reason, /waiting at the plan gate/);
  assert.equal(decide(on({ plan: "human" }), null, "plan", { run: "autonomous", canAsk: true }).action, "ask", "a dashboard run can ask through a question card");
  assert.match(decide(on({ prePr: "approver" }), null, "prePr").reason, /Approver isn't running yet/);
  assert.equal(on({}).gates.plan, undefined);
  assert.equal(decide(on({}), null, "plan").mode, "human", "a gate the policy doesn't name is a person's");
});

test("decide: automatic gates pass on their checks", () => {
  const p = on({ spec: "auto", plan: "auto", prePr: "auto" });
  assert.equal(decide(p, { spec: spec(85, "ready") }, "spec").action, "pass");
  assert.equal(decide(p, { spec: spec(60, "needs-work") }, "spec").action, "ask");
  assert.equal(decide(p, { spec: spec(60, "needs-work") }, "spec", { run: "autonomous" }).action, "stop");
  assert.match(decide(p, {}, "spec").reason, /no spec score yet/);
  assert.equal(decide(p, null, "plan").action, "pass");
  const rows = (...r) => ({ stages: r.map(([id, repo, status]) => ({ id, repo, status })) });
  assert.match(decide(p, rows(), "prePr").reason, /no review is recorded/);
  assert.match(decide(p, rows(["review", "api", "done"], ["review", "web", "failed"]), "prePr").reason, /didn't pass for web/);
  assert.match(decide(p, rows(["review", "api", "done"]), "prePr").reason, /security stage hasn't run/);
  assert.match(decide(p, rows(["review", "api", "done"], ["security", "api", "failed"]), "prePr").reason, /security stage failed for api/);
  // The latest row per repo counts: failed, then done.
  assert.equal(decide(p, rows(["review", "api", "failed"], ["review", "api", "done"], ["security", "api", "done"]), "prePr").action, "pass");
  const noSec = { ...p, stages: [{ id: "security", on: false }] };
  assert.equal(stageOn(noSec, "security"), false);
  assert.equal(decide(noSec, rows(["review", "api", "done"]), "prePr").action, "pass");
});

test("decide: an unattended run below the team's minimum spec score stops whatever the spec gate is", () => {
  const r = decide(on({ spec: "off" }), { spec: spec(40, "not-ready", 60) }, "spec", { run: "autonomous" });
  assert.equal(r.action, "stop");
  assert.match(r.reason, /below the team's minimum/);
  assert.equal(decide(on({ spec: "off" }), { spec: spec(40, "not-ready", 60) }, "spec").action, "skip", "interactive runs aren't stopped by it");
});

test("wip counts other started tickets that aren't done, against the limit", () => {
  const ws = tmp("wip-");
  const dir = path.join(ws, ".claude", "ledger", "factory");
  fs.mkdirSync(dir, { recursive: true });
  const put = (t, m) => fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify({ ticket: t, stages: [], gates: [], ...m }));
  put("ENG-1", { stages: [{ id: "build" }] });
  put("ENG-2", { gates: [{ id: "spec" }] });
  put("ENG-3", { stages: [{ id: "build" }], done: true });
  put("ENG-4", {});
  put("ENG-9", { stages: [{ id: "plan" }] });
  const r = wip(ws, "eng-9", { enabled: true, limits: { wip: 2 } });
  assert.deepEqual([r.inFlight.sort(), r.limit, r.ok], [["ENG-1", "ENG-2"], 2, false]);
  assert.equal(wip(ws, "ENG-9", { enabled: false, limits: { wip: 2 } }).ok, true, "no limit without a policy on");
});

function repo(dir, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  g("checkout", "-q", "-b", "feature/x");
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  return dir;
}

test("a scanner passes on exit 0, finds on any other exit, and is skipped when it isn't installed", () => {
  const dir = repo(tmp("scan-"));
  const s = (command) => runScanner({ name: "x", command, failOn: "high" }, dir);
  assert.equal(s(`node -e "process.exit(0)"`).status, "passed");
  const found = s(`node -e "console.log('1 high severity vulnerability'); process.exit(1)"`);
  assert.deepEqual([found.status, found.severity], ["found", "high"]);
  assert.match(found.detail, /1 high severity vulnerability/);
  assert.equal(s("definitely-not-a-scanner-xyz --audit").status, "skipped");
});

test("the security stage runs the scanners that apply per repo, fails at the policy's severity, and records it", () => {
  const ws = tmp("secws-");
  fs.mkdirSync(path.join(ws, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "api", relativePath: "api" }, { name: "web", relativePath: "web" }] }));
  repo(path.join(ws, "api"), { "package-lock.json": "{}" });
  repo(path.join(ws, "web"), { "new.ts": "export const a = 1;\n" });
  const policy = { enabled: true, security: { failOn: "high", secretScan: false, scanners: [
    { name: "audit", command: `node -e "process.exit(1)"`, when: "package-lock.json", failOn: "high" },
    { name: "lint-sec", command: `node -e "process.exit(2)"`, when: null, failOn: "low" },
  ] } };
  const r = securityScan({ root: ws, policy });
  const by = Object.fromEntries(r.repos.map((x) => [x.repo, x]));
  assert.deepEqual(r.failed, ["api"]);
  assert.deepEqual(by.api.scanners.map((s) => [s.name, s.status]), [["audit", "found"], ["lint-sec", "found"]]);
  assert.match(by.api.note, /Fails at high: audit \(high\)/);
  assert.deepEqual(by.web.scanners.map((s) => s.name), ["lint-sec"], "audit only where its file is");
  assert.equal(by.web.status, "done", "a low finding doesn't fail at high");
  assert.equal(by.web.secrets.status, "skipped");
  assert.deepEqual(changedFiles(path.join(ws, "web"), "main"), ["new.ts"]);

  fs.writeFileSync(path.join(ws, ".claude", "dashboard", "factory.json"), JSON.stringify(policy));
  const cli = spawnSync(process.execPath, [path.join(HERE, "..", "security-scan.mjs"), "--root", ws, "--ticket", "ENG-5"], { encoding: "utf-8" });
  assert.equal(cli.status, 1, "a failing repo exits 1");
  assert.match(cli.stdout, /api: FAILED/);
  const m = JSON.parse(fs.readFileSync(path.join(ws, ".claude", "ledger", "factory", "ENG-5.json"), "utf-8"));
  assert.deepEqual(m.stages.map((s) => [s.id, s.repo, s.status]), [["security", "api", "failed"], ["security", "web", "done"]]);
});
