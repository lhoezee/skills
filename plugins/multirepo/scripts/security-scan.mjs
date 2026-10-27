#!/usr/bin/env node
/**
 * security-scan.mjs: the factory's security stage, the deterministic half. Runs the team's
 * scanners (.claude/dashboard/factory.json security.scanners) in each repo they apply to, and
 * secret scanning (gitleaks) over the files the branch changed. The agent security review is
 * the other half; the implement skill runs it as a subagent.
 *
 * A scanner runs in a repo when its `when` file is at the repo's root (null: every repo). Its
 * command is the team's, from their committed policy, run through the shell in the repo. Exit 0
 * passes; any other exit is a finding at the scanner's `failOn` severity; a command that isn't
 * installed is skipped and said so. A secret is critical. A repo fails the stage when a finding
 * is at the policy's `security.failOn` or worse.
 *
 * Usage:
 *   node security-scan.mjs --root <WORKROOT> [--repos a,b] [--ticket <id>] [--json]
 *
 *   --ticket  record each repo's result as its security stage on the Factory board.
 * Exits 1 when a repo fails the stage, 0 otherwise.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defaultBranch, git, isMain, listRepos, parseArgs } from "./lib.mjs";
import { readPolicy, sourceWorkspace, update } from "./factory.mjs";

const SEVERITIES = ["critical", "high", "medium", "low"];
const OUTPUT_TAIL = 1500;
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;

/** The scanners the dashboard suggests when the policy has none (the same list as Factory → Policy). */
export const DEFAULT_SCANNERS = [
  { name: "npm audit", command: "npm audit --audit-level=high", when: "package-lock.json", failOn: "high" },
  { name: "pip-audit", command: "pip-audit -r requirements.txt", when: "requirements.txt", failOn: "high" },
  { name: "govulncheck", command: "govulncheck ./...", when: "go.mod", failOn: "high" },
];

const worse = (a, b) => SEVERITIES.indexOf(a) <= SEVERITIES.indexOf(b);
const tail = (s) => { const t = String(s || "").trim(); return t.length > OUTPUT_TAIL ? "…" + t.slice(-OUTPUT_TAIL) : t; };

/** Whether a failed run means the command isn't installed (not a finding). */
function notInstalled(r) {
  if (r.error && r.error.code === "ENOENT") return true;
  const err = String(r.stderr || "") + String(r.stdout || "");
  return r.status === 127 || r.status === 9009 || /is not recognized as an internal or external command|command not found|not found: /i.test(err);
}

/** Runs one scanner in a repo: { name, command, status: passed|found|skipped|error, severity, detail }. */
export function runScanner(s, repoPath, run = spawnSync) {
  const r = run(s.command, { cwd: repoPath, shell: true, encoding: "utf-8", timeout: SCAN_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const base = { name: s.name, command: s.command };
  if (r.error && r.error.code === "ETIMEDOUT") return { ...base, status: "error", severity: null, detail: "Timed out after 5 minutes." };
  if (notInstalled(r)) return { ...base, status: "skipped", severity: null, detail: `Not installed here (${s.command.split(/\s+/)[0]}).` };
  if (r.status === 0) return { ...base, status: "passed", severity: null, detail: "" };
  return { ...base, status: "found", severity: s.failOn, detail: tail(r.stdout || r.stderr) };
}

/** Files the branch changed in a repo (committed since the default branch, plus uncommitted and untracked). */
export function changedFiles(repoPath, base) {
  const out = new Set();
  const add = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((f) => out.add(f));
  const mergeBase = git(repoPath, ["merge-base", "HEAD", `origin/${base}`]) || git(repoPath, ["merge-base", "HEAD", base]);
  if (mergeBase) add(git(repoPath, ["diff", "--name-only", "--diff-filter=ACMR", mergeBase, "HEAD"]));
  add(git(repoPath, ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]));
  add(git(repoPath, ["ls-files", "--others", "--exclude-standard"]));
  return [...out].filter((f) => fs.existsSync(path.join(repoPath, f)));
}

/** gitleaks over the changed files: { status: passed|found|skipped, detail }. */
export function scanSecrets(repoPath, files, run = spawnSync) {
  const probe = run("gitleaks", ["version"], { encoding: "utf-8", windowsHide: true });
  if (probe.error || probe.status !== 0) return { status: "skipped", detail: "gitleaks isn't installed, so secrets weren't scanned." };
  if (!files.length) return { status: "passed", detail: "No changed files." };
  const hits = [];
  for (const f of files) {
    const r = run("gitleaks", ["dir", f, "--no-banner", "--redact", "--exit-code", "1"], { cwd: repoPath, encoding: "utf-8", windowsHide: true, timeout: 60_000 });
    if (r.status === 1) hits.push(f);
  }
  return hits.length ? { status: "found", detail: `Possible secrets in ${hits.join(", ")}.` } : { status: "passed", detail: `${files.length} changed files clean.` };
}

/** The security stage for each repo under root. */
export function securityScan({ root, repos = null, policy = null, run = spawnSync } = {}) {
  const sec = (policy && policy.security) || {};
  const scanners = Array.isArray(sec.scanners) ? sec.scanners.filter((s) => s && typeof s.command === "string" && s.command.trim()) : DEFAULT_SCANNERS;
  const failOn = SEVERITIES.includes(sec.failOn) ? sec.failOn : "high";
  const secrets = sec.secretScan !== false;
  const targets = listRepos(root).filter((r) => r.exists && (!repos || repos.includes(r.name)));
  const results = targets.map((r) => {
    const ran = scanners
      .filter((s) => !s.when || fs.existsSync(path.join(r.path, s.when)))
      .map((s) => runScanner({ name: s.name || s.command, command: s.command.trim(), failOn: SEVERITIES.includes(s.failOn) ? s.failOn : "high" }, r.path, run));
    const secret = secrets ? scanSecrets(r.path, changedFiles(r.path, defaultBranch(r.path, r.defaultBranch)), run) : { status: "skipped", detail: "Secret scanning is off." };
    const findings = [...ran.filter((x) => x.status === "found").map((x) => ({ severity: x.severity, what: x.name })), ...(secret.status === "found" ? [{ severity: "critical", what: "secrets" }] : [])];
    const blocking = findings.filter((f) => worse(f.severity, failOn));
    const status = blocking.length ? "failed" : "done";
    const parts = [
      ran.length ? ran.map((x) => `${x.name} ${x.status}`).join(", ") : "no scanner applies",
      `secrets ${secret.status}`,
    ];
    const note = `${blocking.length ? `Fails at ${failOn}: ${blocking.map((f) => `${f.what} (${f.severity})`).join(", ")}. ` : ""}${parts.join("; ")}.`;
    return { repo: r.name, path: r.path, status, note, scanners: ran, secrets: secret };
  });
  return { failOn, repos: results, failed: results.filter((r) => r.status === "failed").map((r) => r.repo) };
}

async function main(argv) {
  const args = parseArgs(argv, { booleans: ["json"] });
  const root = typeof args.root === "string" ? path.resolve(args.root) : process.cwd();
  const ws = sourceWorkspace(root);
  const repos = typeof args.repos === "string" ? args.repos.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const result = securityScan({ root, repos, policy: readPolicy(ws) });
  if (typeof args.ticket === "string") {
    for (const r of result.repos) update("stage", { ticket: args.ticket, stage: "security", status: r.status, repo: r.repo, agent: "security-scan", note: r.note }, { start: root });
  }
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else {
    const lines = [`Security stage (fails at ${result.failOn}):`];
    for (const r of result.repos) {
      lines.push(`  ${r.repo}: ${r.status === "failed" ? "FAILED" : "passed"}: ${r.note}`);
      for (const s of r.scanners.filter((x) => x.status === "found" || x.status === "error")) lines.push(`    ${s.name}: ${s.detail.split("\n").slice(-6).join("\n      ")}`);
    }
    if (!result.repos.length) lines.push("  No repos to scan.");
    process.stdout.write(lines.join("\n") + "\n");
  }
  if (result.failed.length) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exitCode = e.usage ? 2 : 1;
  });
}
