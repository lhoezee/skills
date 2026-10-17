#!/usr/bin/env node
/**
 * prepare-review.mjs: scaffold a second-opinion review and discover what changed.
 *
 * A review covers one unit of work, which may span several repos (a multi-repo
 * workspace) or live in a single repo. This finds every repo under the root with
 * work to review (commits ahead of its base branch and/or a dirty working tree),
 * creates the inbox/outbox state folders, writes a manifest the reviewer prompt
 * reads, and keeps the review state itself out of every diff.
 *
 * Project-agnostic: the repo layout is discovered, the base branch is detected
 * per repo, and the ticket id is inferred from the branch or folder name.
 *
 * Usage:
 *   node prepare-review.mjs [--root <dir>] [--id <reviewId>] [--base <branch>]
 *
 *   --root  Workspace/worktree root (or a single repo). Default: cwd.
 *   --id    Review id, the state folder's name. Default: the ticket id in a
 *           branch or the folder name (e.g. ENG-196), else "adhoc-<timestamp>".
 *   --base  Base branch to diff against. Default: per repo, repos.json's
 *           defaultBranch, else origin's default branch, else main/master/develop.
 *
 * Output: JSON to stdout ({ reviewId, reviewDir, inbox, outbox, repos[] }, each
 * repo with its diff commands and its untracked `newFiles`); a
 * human-readable summary to stderr.
 *
 * git runs through execFileSync with argument arrays (no shell), so it behaves
 * the same on Windows, macOS and Linux.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseArgs(argv) {
  // base: null means "detect per repo".
  const out = { root: process.cwd(), id: null, base: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") out.root = argv[++i];
    else if (a === "--id") out.id = argv[++i];
    else if (a === "--base") out.base = argv[++i];
  }
  out.root = path.resolve(out.root);
  return out;
}

/** Runs git in repoPath; "" on any failure, so callers can branch on emptiness. */
function git(repoPath, args) {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function isGitRepo(dir) {
  return git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

function readJson(file) {
  try {
    // Strip a leading BOM (common in JSON written on Windows).
    return JSON.parse(fs.readFileSync(file, "utf-8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/**
 * Candidate repos under root, in precedence order:
 *   1. .worktree.json `repos` (a worktree: only the repos cloned into it).
 *   2. repos.json `repos`: strings, or objects with relativePath (or the older
 *      directory / path) and name; defaultBranch is kept as the repo's base.
 *   3. root itself, when it's a git repo (a single-repo project).
 *   4. immediate subfolders that are git repos.
 *   5. root, as a last resort.
 * inspectRepo() drops candidates that don't exist or have no changes, so listing
 * too many here is harmless.
 */
export function candidateRepos(root) {
  const norm = (rel) => path.join(root, String(rel).replace(/[\\/]+/g, path.sep));
  const fromManifest = (r) => {
    if (typeof r === "string") return { name: r, path: norm(r) };
    const rel = r.relativePath || r.directory || r.path || r.name;
    return { name: r.name || rel, path: norm(rel), defaultBranch: r.defaultBranch || null };
  };

  const wt = readJson(path.join(root, ".worktree.json"));
  if (wt && Array.isArray(wt.repos) && wt.repos.length) return wt.repos.map(fromManifest);

  const rj = readJson(path.join(root, "repos.json"));
  if (rj && Array.isArray(rj.repos) && rj.repos.length) return rj.repos.map(fromManifest);

  if (isGitRepo(root)) return [{ name: path.basename(root), path: root }];

  try {
    const subs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => ({ name: d.name, path: path.join(root, d.name) }))
      .filter((r) => isGitRepo(r.path));
    if (subs.length) return subs;
  } catch {
    /* fall through */
  }

  return [{ name: path.basename(root), path: root }];
}

/** A repo's default branch: origin/HEAD, then common names. */
function detectDefaultBase(repoPath) {
  const head = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const cand of ["main", "master", "develop"]) {
    if (
      git(repoPath, ["rev-parse", "--verify", "--quiet", cand]) ||
      git(repoPath, ["rev-parse", "--verify", "--quiet", `origin/${cand}`])
    ) {
      return cand;
    }
  }
  return "main";
}

/** `base` as a ref this repo has: local first, then origin/. */
function resolveBase(repoPath, base) {
  if (git(repoPath, ["rev-parse", "--verify", "--quiet", base])) return base;
  const remote = `origin/${base}`;
  if (git(repoPath, ["rev-parse", "--verify", "--quiet", remote])) return remote;
  return null;
}

/**
 * The commands the reviewer runs itself to see the change: the committed range
 * plus uncommitted changes is everything this work touched.
 */
export function buildDiffCommands(resolvedBase, ahead, dirty) {
  const cmds = [];
  if (ahead > 0 && resolvedBase) cmds.push(`git diff ${resolvedBase}...HEAD`);
  if (dirty) cmds.push("git diff HEAD"); // staged + unstaged vs HEAD
  if (cmds.length === 0 && resolvedBase) cmds.push(`git diff ${resolvedBase}...HEAD`);
  return cmds;
}

export function inspectRepo(candidate, requestedBase) {
  const { name, path: repoPath } = candidate;
  if (!fs.existsSync(repoPath) || !isGitRepo(repoPath)) return null;

  const branch = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
  const base = requestedBase || candidate.defaultBranch || detectDefaultBase(repoPath);
  const resolvedBase = resolveBase(repoPath, base);

  let ahead = 0;
  let mergeBase = null;
  if (resolvedBase && branch !== base) {
    mergeBase = git(repoPath, ["merge-base", resolvedBase, "HEAD"]) || null;
    ahead = parseInt(git(repoPath, ["rev-list", "--count", `${resolvedBase}..HEAD`]), 10) || 0;
  }

  const porcelain = git(repoPath, ["status", "--porcelain"]);
  const dirty = porcelain.length > 0;
  const changedFiles = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;

  if (ahead === 0 && !dirty) return null; // nothing to review here

  // Untracked files. `git diff HEAD` doesn't show them, so without a list the
  // reviewer never sees new files, and work left uncommitted until the PR makes
  // brand-new modules, migrations and components the normal case.
  const untracked = git(repoPath, ["ls-files", "--others", "--exclude-standard"]);
  const newFiles = untracked ? untracked.split("\n").filter(Boolean) : [];

  // Diff stat for the summary: the committed range when there is one, else the working tree.
  const diffStat =
    ahead > 0 && resolvedBase
      ? git(repoPath, ["diff", "--stat", `${resolvedBase}...HEAD`])
      : git(repoPath, ["diff", "--stat"]);

  return {
    name,
    path: repoPath.replace(/\\/g, "/"),
    branch,
    base: resolvedBase,
    mergeBase,
    commitsAhead: ahead,
    dirty,
    changedFiles,
    diffCommands: buildDiffCommands(resolvedBase, ahead, dirty),
    diffStat: diffStat || null,
    newFiles, // no diff command surfaces these: read them directly
  };
}

/** The ticket pattern from Natterjack's workspace.json (unanchored), else a typical key. */
export function ticketRegex(root) {
  const ws = readJson(path.join(root, ".claude", "dashboard", "workspace.json"));
  const pattern = ws?.issues?.ticketPattern;
  if (typeof pattern === "string" && pattern) {
    try {
      return new RegExp(`(${pattern.replace(/^\^/, "").replace(/\$$/, "")})`, "i");
    } catch {
      /* fall through */
    }
  }
  return /([A-Z][A-Z0-9]+-\d+)/i; // ABC-123, ENG-196, KREDIT-7833...
}

export function deriveReviewId(root, repos, now = new Date()) {
  const re = ticketRegex(root);
  for (const r of repos) {
    const m = (r.branch || "").match(re);
    if (m) return m[1].toUpperCase();
  }
  const m = path.basename(root).match(re);
  if (m) return m[1].toUpperCase();
  return `adhoc-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

/** Adds .copilot/ to the repo's .git/info/exclude, so reviewing never sees review state. */
function excludeFromGit(repoPath) {
  // In a git worktree, .git is a file pointing elsewhere; ask git for the real dir.
  const gitDir = git(repoPath, ["rev-parse", "--git-dir"]);
  if (!gitDir) return;
  const excludeDir = path.isAbsolute(gitDir) ? path.join(gitDir, "info") : path.join(repoPath, gitDir, "info");
  const exclude = path.join(excludeDir, "exclude");
  try {
    fs.mkdirSync(excludeDir, { recursive: true });
    let body = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf-8") : "";
    if (!body.split(/\r?\n/).some((l) => l.trim() === ".copilot/")) {
      if (body.length && !body.endsWith("\n")) body += "\n";
      fs.writeFileSync(exclude, body + ".copilot/\n");
    }
  } catch {
    /* best effort */
  }
}

export function prepareReview({ root, id = null, base = null }) {
  const repos = candidateRepos(root)
    .map((c) => inspectRepo(c, base))
    .filter(Boolean);
  if (repos.length === 0) return { reviewId: null, repos: [] };

  const reviewId = id || deriveReviewId(root, repos);
  const reviewDir = path.join(root, ".copilot", "reviews", reviewId);
  const inbox = path.join(reviewDir, "inbox");
  const outbox = path.join(reviewDir, "outbox");
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(outbox, { recursive: true });

  excludeFromGit(root);
  for (const r of repos) excludeFromGit(r.path);

  const slash = (p) => p.replace(/\\/g, "/");
  const manifest = {
    reviewId,
    root: slash(root),
    base: base || "auto",
    reviewDir: slash(reviewDir),
    inbox: slash(inbox),
    outbox: slash(outbox),
    repos,
  };
  fs.writeFileSync(path.join(inbox, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = prepareReview(opts);
  if (!manifest.reviewId) {
    process.stderr.write(`No changes to review under ${opts.root} (no commits ahead of base, no working-tree changes).\n`);
  } else {
    process.stderr.write(`Review ${manifest.reviewId}: ${manifest.repos.length} repo(s) with changes:\n`);
    for (const r of manifest.repos) {
      process.stderr.write(
        `  ${r.name} (${r.branch}): ${r.commitsAhead} commit(s) ahead of ${r.base || "?"}` +
          `${r.dirty ? `, ${r.changedFiles} working-tree change(s)` : ""}` +
          `${r.newFiles.length ? `, ${r.newFiles.length} new file(s)` : ""}\n`
      );
    }
    process.stderr.write(`State: ${manifest.reviewDir}\n`);
  }
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
}
