/**
 * Claude Code sessions started in a terminal (or the desktop app, or an IDE) in this workspace,
 * so the dashboard can take one over as a run ("From terminal" on the Activity page, or every
 * new one with limits.adoptSessions). Once it's a run, Remote control mirrors it and Send to
 * hosted moves it like any other.
 *
 * A session is ~/.claude/projects/<folder>/<sessionId>.jsonl, <folder> being its cwd with every
 * character other than a letter or digit made "-" (projectFolder). Only folders whose
 * name is the workspace's (or a worktree's), or starts with it, are read, and each session's own
 * `cwd` decides: a sibling folder (skills-sessions next to skills) has the same prefix.
 *
 * Scripted sessions (`claude -p`, the SDK: entrypoint "sdk-*") are left out: the dashboard's own
 * runs are among them, and the rest are some tool's, not a conversation someone had.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionMode, RunEvent } from "../../shared/api.ts";
import { within } from "../../shared/run-workspace.ts";

/** Read from the start of a session for its cwd, branch and first prompt. */
const HEAD_BYTES = 256 * 1024;
/** How far the head may grow to find a first prompt that doesn't fit in HEAD_BYTES. */
const MAX_HEAD_BYTES = 8 * 1024 * 1024;
/** Read from the end for its latest title. */
const TAIL_BYTES = 64 * 1024;
/** A session bigger than this isn't taken over: its events would be too big to show and sync. */
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const SESSION_RE = /^[a-z0-9-]{8,64}$/i;
const LABEL_MAX = 120;

export interface SessionInfo {
  sessionId: string;
  /** The transcript file. */
  file: string;
  cwd: string;
  /** Its latest title (one set with /rename, else Claude's), else its first prompt. */
  label: string;
  firstPrompt: string;
  branch: string | null;
  /** "cli", "claude-desktop", "claude-vscode"... */
  entrypoint: string | null;
  /** The permission mode it was last in ("default", "acceptEdits", "plan"...), or null. */
  permissionMode: string | null;
  startedAt: string | null;
  /** The file's last write. */
  lastActivityAt: string;
  size: number;
}

/** Claude Code's folder name under ~/.claude/projects for a session started in `cwd`. */
export function projectFolder(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** CLAUDE_CONFIG_DIR, or ~/.claude. */
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** `child` is `parent` or inside it (the run page's rule, shared/run-workspace.ts). */
export function isInside(parent: string, child: string): boolean {
  return within(path.resolve(child), path.resolve(parent));
}

/** A slash command as the CLI records it (<command-name>/goal</command-name>...<command-args>x</command-args>), as typed. */
export function slashCommand(text: string): string | null {
  const name = text.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  if (!name) return null;
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const n = name[1].startsWith("/") ? name[1] : `/${name[1]}`;
  return [n, args ? args[1].trim() : ""].filter(Boolean).join(" ");
}

/**
 * The run's permission mode for a session's: the same where the dashboard has it; plan mode is
 * the run's plan switch; anything that would have asked ("default", or one we don't know) is
 * dontAsk, since a dashboard turn can't ask; bypassPermissions is narrowed to auto.
 */
export function runPermission(mode: string | null): { permissionMode: PermissionMode; planMode: boolean } {
  if (mode === "plan") return { permissionMode: "dontAsk", planMode: true };
  if (mode === "acceptEdits" || mode === "auto" || mode === "dontAsk") return { permissionMode: mode, planMode: false };
  if (mode === "bypassPermissions") return { permissionMode: "auto", planMode: false };
  return { permissionMode: "dontAsk", planMode: false };
}

/**
 * One transcript line -> an event the run page renders, or null. Keeps main-thread user
 * prompts, assistant turns and tool results newer than the cutoff. With `commands`, a slash
 * command reads as typed (`command: true` on the event); without, it's dropped.
 */
export function normaliseTranscriptEntry(e: any, cutoff: number, commands = false): RunEvent | null {
  if (!e || e.isSidechain || e.isMeta || !e.timestamp || !e.message) return null;
  if (Date.parse(e.timestamp) <= cutoff) return null;
  const base = { uuid: e.uuid, timestamp: e.timestamp };
  if (e.type === "assistant") {
    const blocks = (e.message.content || []).filter((b: any) => b.type === "text" || b.type === "tool_use");
    return blocks.length ? { ...base, type: "assistant", parent_tool_use_id: null, message: { content: blocks } } : null;
  }
  if (e.type !== "user") return null;
  const content = e.message.content;
  if (typeof content === "string") {
    const t = content.trim();
    if (t.startsWith("<command-")) {
      const cmd = commands ? slashCommand(t) : null;
      return cmd ? { ...base, type: "human", text: cmd, command: true } : null;
    }
    if (/^<(local-command|system-reminder)/.test(t)) return null;
    return { ...base, type: "human", text: content };
  }
  if (!Array.isArray(content)) return null;
  if (content.some((b: any) => b.type === "tool_result")) return { ...base, type: "user", parent_tool_use_id: null, message: { content } };
  const text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  return text ? { ...base, type: "human", text } : null;
}

function readSlice(file: string, start: number, length: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line cut by the slice */ }
  }
  return out;
}

/** Which of a session's prompts is its first: the first that isn't a slash command (/clear, /model), else the first. -1 when there are none. */
export function firstPromptIndex(events: RunEvent[]): number {
  const humans = events.map((e, i) => (e.type === "human" ? i : -1)).filter((i) => i >= 0);
  return humans.find((i) => !events[i].command) ?? humans[0] ?? -1;
}

/** The last thing Claude said in these events (its text blocks), up to `max` characters, or null. */
export function lastAssistantText(events: RunEvent[], max: number): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "assistant") continue;
    const text = (e.message?.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    if (text) return text.slice(0, max);
  }
  return null;
}

/** A line Claude answered with: a session without one is only commands (/exit, /resume) or an abandoned prompt. */
const answered = (e: any) => e?.type === "assistant" && !e.isSidechain && Array.isArray(e.message?.content) && e.message.content.some((b: any) => b.type === "text" || b.type === "tool_use");

/** What a session's start says, which never changes (the file is only appended to). */
interface Head { bytes: number; first: any; firstPrompt: string; answered: boolean; startedAt: string | null; titles: { custom: string; ai: string }; permissionMode: string | null }

/** Heads by file: a live session's start isn't re-read (up to MAX_HEAD_BYTES) every time it's written. */
const heads = new Map<string, Head>();

function titlesAndMode(lines: any[], into: { custom: string; ai: string }, mode: string | null): string | null {
  for (const e of lines) {
    if (e?.type === "custom-title" && typeof e.customTitle === "string") into.custom = e.customTitle;
    else if (e?.type === "ai-title" && typeof e.aiTitle === "string") into.ai = e.aiTitle;
    else if (e?.type === "permission-mode" && typeof e.permissionMode === "string") mode = e.permissionMode;
  }
  return mode;
}

function readHead(file: string, size: number): Head {
  const cached = heads.get(file);
  // Kept while the file is at least as long as what was read (a shorter one was rewritten).
  if (cached && size >= cached.bytes && (cached.firstPrompt || cached.bytes >= MAX_HEAD_BYTES)) return cached;
  let lines: any[] = [];
  let bytes = HEAD_BYTES;
  let prompts: RunEvent[] = [];
  for (; ; bytes = Math.min(bytes * 4, MAX_HEAD_BYTES)) {
    lines = parseLines(readSlice(file, 0, Math.min(size, bytes)));
    prompts = lines.map((e) => normaliseTranscriptEntry(e, 0, true)).filter((ev): ev is RunEvent => !!ev && ev.type === "human");
    // Grows only when nothing was said in it yet: its first line may be a cut-off paste.
    if (prompts.length || bytes >= size || bytes >= MAX_HEAD_BYTES) break;
  }
  const asked = prompts[firstPromptIndex(prompts)];
  const titles = { custom: "", ai: "" };
  const head: Head = {
    bytes: Math.min(size, bytes),
    first: lines.find((e) => e && typeof e.cwd === "string") ?? null,
    firstPrompt: asked ? String(asked.text) : "",
    answered: lines.some(answered),
    startedAt: lines.find((e) => typeof e?.timestamp === "string")?.timestamp ?? null,
    titles,
    permissionMode: titlesAndMode(lines, titles, null),
  };
  if (heads.size > 5000) heads.clear();
  // Cached once it's settled: a first prompt found, or as far as it'll grow.
  if (head.firstPrompt || head.bytes >= MAX_HEAD_BYTES) heads.set(file, head);
  return head;
}

/** An assistant line as written (inside another line's JSON, e.g. an api-request-blob, it would be escaped). */
const ASSISTANT_LINE = Buffer.from('"type":"assistant"');
/** How far each file was searched by answeredBetween, and whether an assistant line turned up. */
const answeredScans = new Map<string, { to: number; found: boolean }>();

/**
 * Whether Claude answered somewhere between the head and the end: Claude Code writes the whole
 * request (api-request-blob lines, hundreds of KB) between a prompt and its answer, so a short
 * session's answer can be in neither the head nor the tail. A byte search, not a parse; each file
 * is searched once, then only what was added since.
 */
function answeredBetween(file: string, from: number, size: number): boolean {
  const prev = answeredScans.get(file);
  if (prev?.found) return true;
  let at = prev && prev.to <= size ? Math.max(from, prev.to - ASSISTANT_LINE.length) : from;
  const chunk = 1024 * 1024;
  let found = false;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(chunk);
      while (at < size && !found) {
        const n = fs.readSync(fd, buf, 0, Math.min(chunk, size - at), at);
        if (!n) break;
        found = buf.subarray(0, n).includes(ASSISTANT_LINE);
        // Overlap by the pattern's length, so a match split across two chunks is still found.
        at += n >= chunk ? n - ASSISTANT_LINE.length : n;
      }
    } finally { fs.closeSync(fd); }
  } catch { return false; }
  if (answeredScans.size > 5000) answeredScans.clear();
  answeredScans.set(file, { to: size, found });
  return found;
}

/** What a session is, from its start (readHead) and its last lines; null when it isn't one to list (scripted, unanswered, unreadable). */
export function readSessionInfo(file: string): SessionInfo | null {
  const sessionId = path.basename(file, ".jsonl");
  if (!SESSION_RE.test(sessionId)) return null;
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || !st.size) return null;
  let head: Head, tail: any[];
  try {
    head = readHead(file, st.size);
    tail = st.size > head.bytes ? parseLines(readSlice(file, Math.max(0, st.size - TAIL_BYTES), Math.min(TAIL_BYTES, st.size))) : [];
  } catch { return null; }
  const first = head.first;
  if (!first || !head.firstPrompt) return null;
  const entrypoint = typeof first.entrypoint === "string" ? first.entrypoint : null;
  if (entrypoint && entrypoint.startsWith("sdk")) return null;
  if (!head.answered && !tail.some(answered) && !answeredBetween(file, head.bytes, st.size)) return null;
  const titles = { ...head.titles };
  const permissionMode = titlesAndMode(tail, titles, head.permissionMode);
  const label = (titles.custom || titles.ai || head.firstPrompt).replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
  return {
    sessionId,
    file,
    cwd: first.cwd,
    label,
    firstPrompt: head.firstPrompt,
    branch: typeof first.gitBranch === "string" && first.gitBranch && first.gitBranch !== "HEAD" ? first.gitBranch : null,
    entrypoint,
    permissionMode,
    startedAt: head.startedAt,
    lastActivityAt: st.mtime.toISOString(),
    size: st.size,
  };
}

export interface ListOptions {
  /** CLAUDE_CONFIG_DIR, or ~/.claude. */
  claudeDir: string;
  /** The main workspace and its worktrees: a session started in or under one of them is listed. */
  roots: string[];
  /** Sessions already a run here. */
  exclude: Set<string>;
  /** Only sessions written to since then (ms since the epoch). */
  since?: number;
  /** Only sessions started since then (ms): checked before `limit`, so older ones written lately don't crowd them out. */
  startedSince?: number;
  limit?: number;
}

/** The project folders a session started in or under one of `roots` can be in (a sibling with the same prefix too: check its cwd). */
function projectDirs(claudeDir: string, roots: string[]): string[] {
  const base = path.join(claudeDir, "projects");
  const prefixes = roots.map((r) => projectFolder(path.resolve(r)).toLowerCase());
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(base); } catch { return []; }
  return dirs.filter((d) => { const l = d.toLowerCase(); return prefixes.some((p) => l === p || l.startsWith(`${p}-`)); }).map((d) => path.join(base, d));
}

/** readSessionInfo by file and its last write: a sweep every 30 s doesn't re-read what hasn't changed (or was turned down). */
const infoCache = new Map<string, { mtime: number; info: SessionInfo | null }>();
function cachedInfo(file: string, mtime: number): SessionInfo | null {
  const hit = infoCache.get(file);
  if (hit && hit.mtime === mtime) return hit.info;
  const info = readSessionInfo(file);
  if (infoCache.size > 5000) infoCache.clear();
  infoCache.set(file, { mtime, info });
  return info;
}

/** This workspace's sessions, latest activity first. */
export function listSessions(o: ListOptions): SessionInfo[] {
  const files: { file: string; mtime: number }[] = [];
  for (const dir of projectDirs(o.claudeDir, o.roots)) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl") || o.exclude.has(n.slice(0, -6))) continue;
      const file = path.join(dir, n);
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      if (o.since && mtime < o.since) continue;
      files.push({ file, mtime });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const { file, mtime } of files) {
    if (o.limit && out.length >= o.limit) break;
    const info = cachedInfo(file, mtime);
    if (!info || seen.has(info.sessionId) || !o.roots.some((r) => isInside(r, info.cwd))) continue;
    if (o.startedSince && !(info.startedAt && Date.parse(info.startedAt) >= o.startedSince)) continue;
    seen.add(info.sessionId);
    out.push(info);
  }
  return out;
}

/** One of this workspace's sessions by id (as listSessions would list it), or null. */
export function findSession(o: { claudeDir: string; roots: string[]; sessionId: string }): SessionInfo | null {
  if (!SESSION_RE.test(o.sessionId)) return null;
  for (const dir of projectDirs(o.claudeDir, o.roots)) {
    const file = path.join(dir, `${o.sessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const info = readSessionInfo(file);
    if (info && o.roots.some((r) => isInside(r, info.cwd))) return info;
  }
  return null;
}

function tooBig(size: number) {
  return Object.assign(new Error(`This session is ${(size / 1048576).toFixed(0)} MB, over the ${MAX_SESSION_BYTES / 1048576} MB the dashboard takes over. Carry on in the terminal.`), { status: 413 });
}

/** How a run moved in from another folder (RunManager.moveIn) is told so: Send to hosted's import replaces it with its own. */
export const MOVED_FOLDER_NOTE = "This conversation was moved here from another folder on this computer";

/** Runs from a terminal session with no turn from the dashboard yet: kept out of review lists, stats and standup. */
export const terminalOnlyRun = (r: { trigger?: string | null; turns?: number }) => String(r.trigger || "").startsWith("terminal") && (r.turns ?? 1) <= 1;

/** A line written by a scripted `claude -p` (the dashboard's own turns), not by someone at a terminal. */
export const scripted = (e: any) => typeof e?.entrypoint === "string" && e.entrypoint.startsWith("sdk");

export interface ReadOptions {
  /** Slash commands as prompts (normaliseTranscriptEntry). */
  commands?: boolean;
  /**
   * Only what was said at a terminal: lines written by `claude -p` (the dashboard's own turns) are
   * left out by their entrypoint, whatever their time; `cutoff` then applies only to a line that
   * names no entrypoint.
   */
  terminalOnly?: boolean;
  /** The terminal's tool calls still waiting for a result when the last read ended (terminalOnly). */
  pending?: string[];
}

export interface ReadResult {
  events: RunEvent[];
  /** The timestamp of the last line read, or null. */
  lastAt: string | null;
  /** Where the next read starts: after the last whole line, so a line still being written is read next time. */
  to: number;
  /** A terminal line was read (terminalOnly). */
  fromTerminal: boolean;
  /** The terminal's tool calls with no result yet, as of the end of this read (terminalOnly): it's still working while there are any. */
  pending: string[];
  /** The file was shorter than `from` (rewritten), so it was read from the start. */
  restarted: boolean;
}

/**
 * A session's events after `cutoff` (ms) from byte `from` on. A file shorter than `from`
 * (rewritten) is read from the start. Throws 413 when that's over MAX_SESSION_BYTES (its `size`
 * says how far the file goes).
 */
export function readSessionEvents(file: string, cutoff = 0, from = 0, opts: ReadOptions = {}): ReadResult {
  const size = fs.statSync(file).size;
  const start = from > size ? 0 : from;
  // The cap is on what's read: the whole session when it's taken over, then only what's new.
  if (size - start > MAX_SESSION_BYTES) throw Object.assign(tooBig(size - start), { size });
  let buf = Buffer.alloc(0);
  if (start < size) {
    const fd = fs.openSync(file, "r");
    try { buf = Buffer.alloc(size - start); buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, start)); } finally { fs.closeSync(fd); }
  }
  // Up to the last newline byte: the offset never lands inside a line or a character.
  const end = buf.lastIndexOf(0x0a) + 1;
  const restarted = from > size;
  const pending = new Set(restarted ? [] : opts.pending || []);
  const out: ReadResult = { events: [], lastAt: null, to: start + end, fromTerminal: false, pending: [], restarted };
  for (const e of parseLines(buf.subarray(0, end).toString("utf-8"))) {
    if (typeof e?.timestamp === "string" && (!out.lastAt || e.timestamp > out.lastAt)) out.lastAt = e.timestamp;
    if (opts.terminalOnly) {
      if (scripted(e)) continue;
      const named = typeof e?.entrypoint === "string";
      if (named) out.fromTerminal = true;
      const ev = normaliseTranscriptEntry(e, named ? 0 : cutoff, !!opts.commands);
      if (!ev) continue;
      // Each tool call is pending until its result comes (several can run at once).
      for (const b of ev.message?.content || []) {
        if (ev.type === "assistant" && b.type === "tool_use" && b.id) pending.add(String(b.id));
        else if (ev.type === "user" && b.type === "tool_result" && b.tool_use_id) pending.delete(String(b.tool_use_id));
      }
      if (ev.type === "human") pending.clear(); // a new prompt: whatever was running was stopped
      out.events.push(ev);
      continue;
    }
    const ev = normaliseTranscriptEntry(e, cutoff, !!opts.commands);
    if (ev) out.events.push(ev);
  }
  out.pending = [...pending];
  return out;
}

/**
 * Folders on this computer where Claude Code was used interactively, newest first, to offer as
 * other folders (Settings): each project folder's path read from one of its sessions (folder names
 * can't be turned back into paths), a folder inside another listed one folded into it, and those
 * in or under `skip` (the workspace) left out. `sessions` counts session files, not only listable ones.
 */
export function suggestFolders(claudeDir: string, skip: string[], limit = 30): { path: string; sessions: number; lastActivityAt: string }[] {
  const base = path.join(claudeDir, "projects");
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(base); } catch { return []; }
  const found: { path: string; sessions: number; mtime: number }[] = [];
  for (const d of dirs) {
    let files: { file: string; mtime: number }[] = [];
    try {
      files = fs.readdirSync(path.join(base, d)).filter((n) => n.endsWith(".jsonl"))
        .map((n) => { const file = path.join(base, d, n); return { file, mtime: fs.statSync(file).mtimeMs }; })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { continue; }
    // The newest few: a folder used only by scripts (claude -p) has none to read a path from, and isn't offered.
    const info = files.slice(0, 5).map((f) => cachedInfo(f.file, f.mtime)).find(Boolean);
    if (!info || skip.some((r) => isInside(r, info.cwd) || isInside(info.cwd, r))) continue;
    found.push({ path: info.cwd, sessions: files.length, mtime: files[0].mtime });
  }
  // A repo's own folder inside a listed workspace folds into it (picking the outer one covers both).
  const outer = found.filter((f) => !found.some((o) => o !== f && o.path.length < f.path.length && isInside(o.path, f.path)));
  for (const o of outer) {
    for (const f of found) if (f !== o && isInside(o.path, f.path)) { o.sessions += f.sessions; o.mtime = Math.max(o.mtime, f.mtime); }
  }
  return outer.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => ({ path: f.path, sessions: f.sessions, lastActivityAt: new Date(f.mtime).toISOString() }));
}

/**
 * A copy of a session, to carry on in another folder (Move into this workspace): under a new
 * session id, in Claude Code's project folder for `cwd` so `claude --resume` finds it from there,
 * every line's sessionId rewritten, and its side folder (subagents, tool results) copied along.
 * The original is left as it was. Returns the copy, or throws (413 over MAX_SESSION_BYTES).
 */
export function forkSession(session: SessionInfo, cwd: string, claudeDir: string, newId: string): SessionInfo {
  const size = fs.statSync(session.file).size;
  if (size > MAX_SESSION_BYTES) throw tooBig(size);
  const dir = path.join(claudeDir, "projects", projectFolder(path.resolve(cwd)));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${newId}.jsonl`);
  if (fs.existsSync(file)) throw Object.assign(new Error("A copy with that id is already there."), { status: 409 });
  const lines = fs.readFileSync(session.file, "utf-8").split("\n").map((line) => {
    if (!line.includes(session.sessionId)) return line;
    try {
      const e = JSON.parse(line);
      if (e && e.sessionId === session.sessionId) e.sessionId = newId;
      return JSON.stringify(e);
    } catch { return line; }
  });
  fs.writeFileSync(file, lines.join("\n"));
  const side = path.join(path.dirname(session.file), session.sessionId);
  if (fs.existsSync(side)) fs.cpSync(side, path.join(dir, newId), { recursive: true, dereference: false });
  const copy = readSessionInfo(file);
  if (!copy) { fs.rmSync(file, { force: true }); throw new Error("The copy couldn't be read back."); }
  return copy;
}
