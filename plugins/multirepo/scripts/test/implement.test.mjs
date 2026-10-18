// implement.mjs against throwaway workspaces whose repos are clones of bare local
// remotes: placement, worktree classification, freshness and branch guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  branchHasTicket, branchPrefix, checkFreshness, classifyWorktree, createBranches, resolvePlacement, stagesOf, worktreeName,
} from "../implement.mjs";
import { createWorktree } from "../worktree.mjs";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
});

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "implement.mjs");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
};
const commit = (repo, file, body, msg) => {
  write(path.join(repo, file), body);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", msg);
};
const head = (dir) => git(dir, "rev-parse", "HEAD");
const branchOf = (dir) => git(dir, "branch", "--show-current");
const slash = (p) => p.replace(/\\/g, "/");

/**
 * A main workspace with repos cloned from bare remotes. Each remote has a seed
 * clone; push(name) adds an upstream commit. workspace.json is written only when
 * `workspace` is given.
 */
function makeWorkspace({ names = ["api", "web"], workspace = null, deps = {} } = {}) {
  const base = tmp("mr-impl-");
  const root = path.join(base, "ws");
  const seeds = {};
  for (const n of names) {
    const bare = path.join(base, "remotes", `${n}.git`);
    fs.mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare", "-b", "main");
    const seed = path.join(base, "seed", n);
    execFileSync("git", ["clone", "-q", bare, seed], { stdio: "pipe" });
    commit(seed, "README.md", "hello\n", "init");
    git(seed, "push", "-q", "origin", "HEAD:main");
    seeds[n] = seed;
    execFileSync("git", ["clone", "-q", bare, path.join(root, n)], { stdio: "pipe" });
  }
  write(path.join(root, "repos.json"), { repos: names.map((n) => ({ name: n, relativePath: n, dependencies: deps[n] || [] })) });
  if (workspace) write(path.join(root, ".claude", "dashboard", "workspace.json"), workspace);
  let k = 0;
  const push = (n) => {
    commit(seeds[n], `up${++k}.txt`, "x\n", `upstream ${k}`);
    git(seeds[n], "push", "-q", "origin", "HEAD:main");
  };
  return { base, root, seeds, push, repo: (n) => path.join(root, n) };
}

const wsWithWorktrees = () => makeWorkspace({ workspace: { issues: { kind: "linear" }, worktrees: {} } });

// ------------------------------------------------------------------ naming

test("worktree names and branch prefixes follow the worktree skill's rules", () => {
  assert.equal(worktreeName("ENG-123"), "ENG-123");
  assert.equal(worktreeName("acme/api#7"), "acme-api-7");
  assert.equal(worktreeName("#42"), "42");
  assert.equal(worktreeName("///"), null);
  assert.equal(branchPrefix("Bug"), "fix/");
  assert.equal(branchPrefix("chore"), "chore/");
  assert.equal(branchPrefix("Story"), "feature/");
  assert.equal(branchPrefix(undefined), "feature/");
  assert.ok(branchHasTicket("fix/ENG-1", "eng-1"));
  assert.ok(branchHasTicket("feature/acme-api-7", "acme/api#7"));
  assert.ok(!branchHasTicket("feature/ENG-2", "ENG-1"));
});

test("stages: a repo comes one stage after the latest repo it consumes; independent repos share a stage", () => {
  const r = (name, dependencies = []) => ({ name, dependencies });
  assert.deepEqual(stagesOf([r("web", ["api"]), r("admin", ["api"]), r("api", ["core"]), r("core"), r("docs")]), [["core", "docs"], ["api"], ["web", "admin"]]);
  assert.deepEqual(stagesOf([r("a", ["b"]), r("b", ["a"])]).flat().sort(), ["a", "b"]); // a cycle drops nothing
  assert.deepEqual(stagesOf([r("a", ["unknown"])]), [["a"]]);
  const ws = makeWorkspace({ names: ["api", "web"], deps: { web: ["api"] } });
  assert.deepEqual(resolvePlacement({ ticket: "ENG-1", root: ws.root }).stages, [["api"], ["web"]]);
});

// ------------------------------------------------------------------ placement

test("flat: no worktrees configured or present → work in place, convention branch", () => {
  const ws = makeWorkspace();
  const r = resolvePlacement({ ticket: "ENG-1", root: ws.root });
  assert.equal(r.placement, "flat");
  assert.equal(r.baseDir, slash(ws.root));
  assert.equal(r.worktree.state, "absent");
  assert.equal(r.branch, "feature/ENG-1");
  assert.equal(r.branchSource, "convention");
  assert.deepEqual(r.repos.map((x) => [x.name, x.branch, x.onDefault, x.dirty, x.ahead, x.behind]), [
    ["api", "main", true, false, 0, 0], ["web", "main", true, false, 0, 0],
  ]);
  assert.equal(resolvePlacement({ ticket: "ENG-1", root: ws.root, type: "Bug" }).branch, "fix/ENG-1");
});

test("worktree-missing: worktrees are configured (or the folder exists) but this ticket has none", () => {
  const ws = wsWithWorktrees();
  assert.equal(resolvePlacement({ ticket: "ENG-1", root: ws.root }).placement, "worktree-missing");
  const plain = makeWorkspace();
  fs.mkdirSync(path.join(plain.root, "worktrees"));
  assert.equal(resolvePlacement({ ticket: "ENG-1", root: plain.root }).placement, "worktree-missing");
});

test("worktree-exists (complete), in-worktree and in-other-worktree; branch precedence flag > worktree > convention", () => {
  const ws = wsWithWorktrees();
  createWorktree({ root: ws.root, name: "ENG-1", repos: "api,web", branch: "fix/ENG-1", ticket: "ENG-1", install: false });
  const wt = path.join(ws.root, "worktrees", "ENG-1");

  const fromMain = resolvePlacement({ ticket: "ENG-1", root: ws.root });
  assert.equal(fromMain.placement, "worktree-exists");
  assert.equal(fromMain.worktree.state, "complete");
  assert.equal(fromMain.baseDir, slash(wt));
  assert.equal(fromMain.branch, "fix/ENG-1"); // not feature/: the worktree chose fix/
  assert.equal(fromMain.branchSource, "worktree");
  assert.ok(fromMain.repos.every((x) => x.onBranch && x.path.startsWith(slash(wt))));
  assert.equal(resolvePlacement({ ticket: "ENG-1", root: ws.root, branch: "feature/x" }).branch, "feature/x");

  const inside = resolvePlacement({ ticket: "eng-1", root: path.join(wt, "api") });
  assert.equal(inside.placement, "in-worktree");
  assert.equal(inside.baseDir, slash(wt));
  assert.equal(inside.mainRoot, slash(ws.root));

  const other = resolvePlacement({ ticket: "ENG-2", root: wt });
  assert.equal(other.placement, "in-other-worktree");
  assert.equal(other.worktree.name, "ENG-1");
  assert.equal(other.worktree.ticketId, "ENG-1");
  assert.equal(other.branch, "feature/ENG-2"); // never the other ticket's branch
});

test("incomplete worktrees: a failed clone with no metadata, or a listed repo missing", () => {
  const ws = wsWithWorktrees();
  fs.mkdirSync(path.join(ws.root, "worktrees", "ENG-3", "web"), { recursive: true }); // half-made, no .worktree.json
  const r = resolvePlacement({ ticket: "ENG-3", root: ws.root });
  assert.equal(r.placement, "worktree-exists");
  assert.equal(r.worktree.state, "incomplete");
  assert.match(r.worktree.problems.join(), /no \.worktree\.json/);

  createWorktree({ root: ws.root, name: "ENG-4", repos: "api", branch: "feature/ENG-4", install: false });
  const wt = path.join(ws.root, "worktrees", "ENG-4");
  const meta = JSON.parse(fs.readFileSync(path.join(wt, ".worktree.json"), "utf-8"));
  write(path.join(wt, ".worktree.json"), { ...meta, repos: ["api", "web"] });
  const c = classifyWorktree(wt);
  assert.equal(c.state, "incomplete");
  assert.deepEqual(c.missingRepos, ["web"]);
  assert.equal(classifyWorktree(path.join(ws.root, "worktrees", "nope")).state, "absent");
});

test("--here: the current checkout, no worktree lookup", () => {
  const ws = wsWithWorktrees();
  createWorktree({ root: ws.root, name: "ENG-5", repos: "api", branch: "feature/ENG-5", install: false });
  const r = resolvePlacement({ ticket: "ENG-5", root: ws.root, here: true });
  assert.equal(r.placement, "here");
  assert.equal(r.baseDir, slash(ws.root));
  assert.equal(r.branch, "feature/ENG-5");
});

test("ports come from the ports file entry for the worktree", () => {
  const base = tmp("mr-impl-ports-");
  const portsFile = path.join(base, "ports.json");
  const ws = makeWorkspace({ workspace: { worktrees: { portsFile } } });
  createWorktree({ root: ws.root, name: "ENG-6", repos: "api", branch: "feature/ENG-6", install: false });
  const wt = path.join(ws.root, "worktrees", "ENG-6");
  write(portsFile, { worktrees: { "ENG-6": { slot: 2, workspace: wt, ports: { api: 24102 } } } });
  const r = resolvePlacement({ ticket: "ENG-6", root: ws.root });
  assert.deepEqual(r.ports.ports, { api: 24102 });
  assert.equal(r.ports.slot, 2);
  assert.equal(resolvePlacement({ ticket: "ENG-7", root: ws.root }).ports, null);
});

test("CLI: --resolve --json prints the placement; a missing --ticket exits 2", () => {
  const ws = makeWorkspace({ names: ["api"] });
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, "--ticket", "ENG-1", "--resolve", "--root", ws.root, "--json"], { encoding: "utf-8" }));
  assert.equal(out.placement, "flat");
  let status = 0;
  try { execFileSync(process.execPath, [SCRIPT, "--resolve", "--root", ws.root], { stdio: "pipe" }); } catch (e) { status = e.status; }
  assert.equal(status, 2);
});

// ------------------------------------------------------------------ freshness

test("freshness: fast-forwards only clean+default+behind; dirty, other-branch, diverged, ahead reported and untouched", async () => {
  const names = ["behind", "dirty", "feature", "diverged", "ahead", "current"];
  const ws = makeWorkspace({ names });
  for (const n of ["behind", "dirty", "feature", "diverged"]) ws.push(n);
  write(path.join(ws.repo("dirty"), "README.md"), "local edit\n");
  git(ws.repo("feature"), "switch", "-q", "-c", "feature/ENG-1");
  for (const n of ["diverged", "ahead"]) commit(ws.repo(n), "local.txt", "x\n", "local");
  const before = Object.fromEntries(names.map((n) => [n, head(ws.repo(n))]));

  const dry = await checkFreshness({ root: ws.root });
  const d = Object.fromEntries(dry.repos.map((x) => [x.name, x]));
  assert.equal(d.behind.state, "behind");
  assert.equal(head(ws.repo("behind")), before.behind); // without --pull nothing moves
  assert.equal(dry.pulled, false);

  const s = await checkFreshness({ root: ws.root, pull: true });
  const r = Object.fromEntries(s.repos.map((x) => [x.name, x]));
  assert.equal(r.behind.state, "fast-forwarded");
  assert.equal(head(ws.repo("behind")), git(ws.repo("behind"), "rev-parse", "origin/main"));
  assert.equal(r.dirty.state, "dirty");
  assert.equal(r.feature.state, "other-branch");
  assert.match(r.feature.detail, /1 behind origin\/main/);
  assert.equal(r.diverged.state, "diverged");
  assert.equal(r.ahead.state, "ahead");
  assert.equal(r.current.state, "up-to-date");
  assert.deepEqual(s.fastForwarded, ["behind"]);
  assert.deepEqual(s.needsDecision.sort(), ["dirty", "diverged", "feature"]);

  for (const n of ["dirty", "feature", "diverged", "ahead", "current"]) assert.equal(head(ws.repo(n)), before[n], n);
  assert.equal(fs.readFileSync(path.join(ws.repo("dirty"), "README.md"), "utf-8"), "local edit\n");
  assert.equal(branchOf(ws.repo("feature")), "feature/ENG-1");
  assert.equal(git(ws.repo("dirty"), "stash", "list"), "");
});

test("freshness: fetch failures and missing repos; --repos and --layer filters", async () => {
  const ws = makeWorkspace({ names: ["api", "web", "gone"] });
  write(path.join(ws.root, "repos.json"), { repos: [
    { name: "api", relativePath: "api", layer: "backend" },
    { name: "web", relativePath: "web", layer: "frontend" },
    { name: "gone", relativePath: "not-here", layer: "backend" },
  ] });
  git(ws.repo("api"), "remote", "set-url", "origin", path.join(ws.base, "remotes", "missing.git"));
  const s = await checkFreshness({ root: ws.root, layer: "backend" });
  assert.deepEqual(s.repos.map((x) => [x.name, x.state]), [["api", "fetch-failed"], ["gone", "missing"]]);
  assert.ok(s.needsDecision.includes("api"));
  const one = await checkFreshness({ root: ws.root, repos: ["web"] });
  assert.deepEqual(one.repos.map((x) => x.name), ["web"]);
  await assert.rejects(checkFreshness({ root: ws.root, repos: ["nope"] }), /Unknown repo\(s\): nope.*Valid: api, web, gone/);
});

// ------------------------------------------------------------------ branches

test("branches: created from origin/<default> (fetched first), with no upstream", () => {
  const ws = makeWorkspace({ names: ["api"] });
  ws.push("api"); // local main is behind and unfetched: the branch still starts at origin's tip
  const r = createBranches({ root: ws.root, branch: "feature/ENG-1", repos: ["api"] });
  assert.equal(r.ticket, "ENG-1");
  assert.deepEqual([r.repos[0].state, r.repos[0].from], ["created", "origin/main"]);
  assert.equal(branchOf(ws.repo("api")), "feature/ENG-1");
  assert.equal(head(ws.repo("api")), git(ws.repo("api"), "rev-parse", "origin/main"));
  assert.throws(() => git(ws.repo("api"), "rev-parse", "--abbrev-ref", "@{u}")); // the first push -u sets it
});

test("branches: an existing remote or local branch is switched to; then already-on", () => {
  const ws = makeWorkspace({ names: ["web", "lib"] });
  git(ws.seeds.web, "push", "-q", "origin", "HEAD:feature/ENG-1");
  git(ws.repo("web"), "fetch", "-q", "origin");
  git(ws.repo("lib"), "branch", "feature/ENG-1");
  const r = createBranches({ root: ws.root, branch: "feature/ENG-1", repos: ["web", "lib"] });
  assert.deepEqual(r.repos.map((x) => [x.name, x.state]), [["web", "switched"], ["lib", "switched"]]);
  assert.equal(git(ws.repo("web"), "rev-parse", "--abbrev-ref", "@{u}"), "origin/feature/ENG-1");
  const again = createBranches({ root: ws.root, branch: "feature/ENG-1", repos: ["web"] });
  assert.equal(again.repos[0].state, "already-on");
});

test("branches: unrelated branch, same ticket on another branch, dirty and missing repos are skipped; nothing stashed", () => {
  const ws = makeWorkspace({ names: ["other", "same", "dirty", "ok"] });
  git(ws.repo("other"), "switch", "-q", "-c", "feature/ENG-9");
  git(ws.repo("same"), "switch", "-q", "-c", "fix/ENG-1");
  write(path.join(ws.repo("dirty"), "README.md"), "edit\n");
  write(path.join(ws.root, "repos.json"), { repos: ["other", "same", "dirty", "ok", { name: "gone", relativePath: "gone" }] });

  const r = createBranches({ root: ws.root, branch: "feature/ENG-1", repos: ["other", "same", "dirty", "ok", "gone"] });
  const by = Object.fromEntries(r.repos.map((x) => [x.name, x]));
  assert.equal(by.other.state, "skipped");
  assert.match(by.other.reason, /unrelated/);
  assert.equal(by.same.state, "skipped");
  assert.match(by.same.reason, /--branch fix\/ENG-1/);
  assert.equal(by.dirty.state, "skipped");
  assert.match(by.dirty.reason, /uncommitted/);
  assert.equal(by.gone.state, "missing");
  assert.equal(by.ok.state, "created");
  assert.equal(branchOf(ws.repo("other")), "feature/ENG-9");
  assert.equal(branchOf(ws.repo("same")), "fix/ENG-1");
  assert.equal(branchOf(ws.repo("dirty")), "main");
  assert.equal(fs.readFileSync(path.join(ws.repo("dirty"), "README.md"), "utf-8"), "edit\n");
  assert.equal(git(ws.repo("dirty"), "stash", "list"), "");
});

test("branches: refused in the main workspace when the ticket's worktree exists; works inside it", () => {
  const ws = wsWithWorktrees();
  createWorktree({ root: ws.root, name: "ENG-1", repos: "api", install: false }); // no --branch: clone on main
  const wt = path.join(ws.root, "worktrees", "ENG-1");
  assert.throws(() => createBranches({ root: ws.root, branch: "feature/ENG-1", repos: ["api"] }), (e) => e.refused && /worktrees\/ENG-1/.test(slash(e.message)));
  assert.equal(branchOf(ws.repo("api")), "main");

  let status = 0;
  try { execFileSync(process.execPath, [SCRIPT, "--branches", "--branch", "feature/ENG-1", "--repos", "api", "--root", ws.root], { stdio: "pipe" }); } catch (e) { status = e.status; }
  assert.equal(status, 1);

  const r = createBranches({ root: wt, branch: "feature/ENG-1", repos: ["api"] });
  assert.equal(r.repos[0].state, "created");
  assert.equal(branchOf(path.join(wt, "api")), "feature/ENG-1");
  assert.equal(branchOf(ws.repo("api")), "main");
});

test("branches: bad arguments", () => {
  const ws = makeWorkspace({ names: ["api"] });
  assert.throws(() => createBranches({ root: ws.root, repos: ["api"] }), /--branch is required/);
  assert.throws(() => createBranches({ root: ws.root, branch: "bad..name", repos: ["api"] }), /Invalid branch/);
  assert.throws(() => createBranches({ root: ws.root, branch: "feature/ENG-1" }), /--repos is required/);
  assert.throws(() => createBranches({ root: ws.root, branch: "feature/ENG-1", repos: ["nope"] }), /Unknown repo/);
});
