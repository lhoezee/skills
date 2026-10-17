// prepare-review.mjs on throwaway repos: discovery, base detection, ids, exclude.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildDiffCommands, candidateRepos, deriveReviewId, prepareReview } from "../prepare-review.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();

/** A repo with one commit on `base`, optionally a branch with one commit ahead. */
function makeRepo(dir, { base = "main", branch = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", base);
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  if (branch) {
    git(dir, "switch", "-q", "-c", branch);
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    git(dir, "commit", "-q", "-am", "change");
  }
  return dir;
}

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("single repo: a branch ahead of main is reviewed, id from the branch, state excluded from git", () => {
  const root = makeRepo(tmp("mr-single-"), { branch: "feature/ENG-42-thing" });
  const m = prepareReview({ root });
  assert.equal(m.reviewId, "ENG-42");
  assert.equal(m.repos.length, 1);
  assert.equal(m.repos[0].commitsAhead, 1);
  assert.equal(m.repos[0].base, "main");
  assert.deepEqual(m.repos[0].diffCommands, ["git diff main...HEAD"]);
  assert.ok(fs.existsSync(path.join(m.inbox, "manifest.json")));
  assert.ok(fs.existsSync(m.outbox));
  assert.match(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf-8"), /^\.copilot\/$/m);
  // The state folder itself doesn't show up as a change.
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("clean repo on its base branch: nothing to review", () => {
  const root = makeRepo(tmp("mr-clean-"));
  const m = prepareReview({ root });
  assert.equal(m.reviewId, null);
  assert.deepEqual(m.repos, []);
  assert.equal(fs.existsSync(path.join(root, ".copilot")), false);
});

test("repos.json workspace: only changed repos, defaultBranch honored, dirty tree counted", () => {
  const root = tmp("mr-ws-");
  makeRepo(path.join(root, "api"), { base: "develop", branch: "fix/OPS-7" });
  makeRepo(path.join(root, "web"));
  makeRepo(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "a.txt"), "dirty\n");
  fs.writeFileSync(
    path.join(root, "repos.json"),
    JSON.stringify({ repos: [{ name: "api", relativePath: "api", defaultBranch: "develop" }, { name: "web" }, "docs"] })
  );

  const names = candidateRepos(root).map((c) => c.name);
  assert.deepEqual(names, ["api", "web", "docs"]);

  const m = prepareReview({ root });
  assert.equal(m.reviewId, "OPS-7");
  assert.deepEqual(m.repos.map((r) => r.name), ["api", "docs"]);
  const api = m.repos.find((r) => r.name === "api");
  assert.equal(api.base, "develop");
  const docs = m.repos.find((r) => r.name === "docs");
  assert.equal(docs.dirty, true);
  assert.deepEqual(docs.diffCommands, ["git diff HEAD"]);
  assert.deepEqual(docs.newFiles, []);
});

test("untracked files are listed in newFiles (no diff command shows them)", () => {
  const root = makeRepo(tmp("mr-new-"), { branch: "feature/ENG-5" });
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "fresh.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.log\n");
  fs.writeFileSync(path.join(root, "ignored.log"), "x\n");
  const [repo] = prepareReview({ root }).repos;
  assert.deepEqual(repo.newFiles.sort(), [".gitignore", "src/fresh.ts"]);
  // An untracked-only change still counts as work to review.
  assert.equal(repo.dirty, true);
});

test(".worktree.json wins over repos.json", () => {
  const root = tmp("mr-wt-");
  fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify({ repos: ["a", "b"] }));
  fs.writeFileSync(path.join(root, ".worktree.json"), JSON.stringify({ repos: ["b"] }));
  assert.deepEqual(candidateRepos(root).map((c) => c.name), ["b"]);
});

test("review id: workspace.json ticketPattern, folder name, then a timestamp", () => {
  const root = tmp("mr-id-");
  fs.mkdirSync(path.join(root, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude", "dashboard", "workspace.json"),
    JSON.stringify({ issues: { ticketPattern: "^[a-z]+/[a-z]+#\\d+$" } })
  );
  assert.equal(deriveReviewId(root, [{ branch: "feature/acme/api#12" }]), "ACME/API#12");

  const named = path.join(tmp("mr-id2-"), "ENG-9");
  fs.mkdirSync(named);
  assert.equal(deriveReviewId(named, [{ branch: "feature/no-ticket" }]), "ENG-9");

  const plain = tmp("mr-id3-");
  assert.equal(deriveReviewId(plain, [{ branch: "x" }], new Date("2026-01-02T03:04:05Z")), "adhoc-2026-01-02T03-04-05");
});

test("diff commands: committed range, working tree, or both", () => {
  assert.deepEqual(buildDiffCommands("main", 2, true), ["git diff main...HEAD", "git diff HEAD"]);
  assert.deepEqual(buildDiffCommands("origin/main", 0, true), ["git diff HEAD"]);
  assert.deepEqual(buildDiffCommands(null, 0, true), ["git diff HEAD"]);
});
