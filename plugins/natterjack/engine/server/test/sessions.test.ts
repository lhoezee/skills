// Sessions from a terminal (sessions.ts) and taking them over as runs (RunManager.adopt,
// absorbTerminal, terminalBusy), against a fake CLAUDE_CONFIG_DIR.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "dash-sessions-cfg-"));
process.env.CLAUDE_CONFIG_DIR = CONFIG;

const { listSessions, findSession, readSessionInfo, normaliseTranscriptEntry, slashCommand, projectFolder, isInside, runPermission, suggestFolders, forkSession } = await import("../src/sessions.ts");
const { RunManager, TERMINAL_QUIET_MS } = await import("../src/runs.ts");

const ROOT = path.join(os.tmpdir(), "dash-sessions-ws", "skills");
const WT = path.join(ROOT, ".claude", "worktrees", "eng-1");
const SIBLING = path.join(os.tmpdir(), "dash-sessions-ws", "skills-other");

let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const ts = (min: number) => new Date(Date.UTC(2026, 9, 1, 10, min)).toISOString();

/** A transcript as Claude Code writes one: a few header lines, then the conversation. */
function writeSession(cwd: string, opts: { entrypoint?: string; lines?: any[]; title?: string; at?: number } = {}): { id: string; file: string } {
  const id = uid();
  const dir = path.join(CONFIG, "projects", projectFolder(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId: id, cwd, entrypoint: opts.entrypoint ?? "cli", gitBranch: "feat/x", isSidechain: false };
  const lines = opts.lines ?? [
    { ...base, type: "user", uuid: uid(), timestamp: ts(0), message: { role: "user", content: "Fix the login bug" } },
    { ...base, type: "assistant", uuid: uid(), timestamp: ts(1), message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Read", input: {} }] } },
    { ...base, type: "user", uuid: uid(), timestamp: ts(2), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] } },
    { ...base, type: "assistant", uuid: uid(), timestamp: ts(3), message: { content: [{ type: "text", text: "Fixed it." }] } },
  ];
  const all = [{ type: "permission-mode", permissionMode: "auto", sessionId: id }, ...lines, ...(opts.title ? [{ type: "ai-title", aiTitle: opts.title, sessionId: id }] : [])];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, all.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const at = new Date(opts.at ?? Date.now() - 3600_000);
  fs.utimesSync(file, at, at);
  return { id, file };
}

function append(file: string, cwd: string, lines: any[], mtime = Date.now()) {
  fs.appendFileSync(file, lines.map((l) => JSON.stringify({ cwd, entrypoint: "cli", isSidechain: false, ...l })).join("\n") + "\n");
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
}

const ledger = () => fs.mkdtempSync(path.join(os.tmpdir(), "dash-sessions-ledger-"));

test("slashCommand and normaliseTranscriptEntry: a slash command reads as typed; local output is dropped", () => {
  assert.equal(slashCommand("<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship it</command-args>"), "/goal ship it");
  assert.equal(slashCommand("<command-name>clear</command-name><command-args></command-args>"), "/clear");
  const e = (content: any) => ({ type: "user", uuid: "u", timestamp: ts(5), message: { content } });
  assert.equal(normaliseTranscriptEntry(e("<command-name>/review</command-name><command-args>42</command-args>"), 0, true)?.text, "/review 42");
  assert.equal(normaliseTranscriptEntry(e("<command-name>/review</command-name><command-args>42</command-args>"), 0), null, "a plain run's terminal continuation leaves commands out, as before");
  assert.equal(normaliseTranscriptEntry(e("<local-command-stdout>ok</local-command-stdout>"), 0), null);
  assert.equal(normaliseTranscriptEntry(e("hello"), Date.parse(ts(5))), null, "at the cutoff is old");
});

test("isInside: the folder itself and below, not a sibling with the same prefix", () => {
  assert.ok(isInside(ROOT, ROOT));
  assert.ok(isInside(ROOT, WT));
  assert.ok(!isInside(ROOT, SIBLING));
});

test("listSessions: the workspace's and its worktrees' interactive sessions, newest first, by title", () => {
  const main = writeSession(ROOT, { title: "Login bug", at: Date.now() - 7200_000 });
  const inWt = writeSession(WT, { at: Date.now() - 60_000 });
  const sub = writeSession(path.join(ROOT, "web"), { at: Date.now() - 1800_000 });
  writeSession(SIBLING); // same folder-name prefix, another folder
  writeSession(ROOT, { entrypoint: "sdk-cli" }); // claude -p
  writeSession(ROOT, { lines: [{ type: "user", cwd: ROOT, uuid: uid(), timestamp: ts(0), message: { content: "<local-command-stdout>x</local-command-stdout>" } }] }); // nothing said
  writeSession(ROOT, { lines: [{ type: "user", cwd: ROOT, entrypoint: "cli", uuid: uid(), timestamp: ts(0), message: { content: "<command-name>/exit</command-name><command-args></command-args>" } }] }); // only /exit: never answered
  const done = writeSession(ROOT);

  const list = listSessions({ claudeDir: CONFIG, roots: [ROOT, WT], exclude: new Set([done.id]) });
  assert.deepEqual(list.map((s) => s.sessionId), [inWt.id, sub.id, main.id]);
  const m = list.find((s) => s.sessionId === main.id)!;
  assert.equal(m.label, "Login bug");
  assert.equal(m.firstPrompt, "Fix the login bug");
  assert.equal(m.branch, "feat/x");
  assert.equal(m.entrypoint, "cli");
  assert.equal(list.find((s) => s.sessionId === inWt.id)!.label, "Fix the login bug", "no title: the first prompt");

  assert.deepEqual(listSessions({ claudeDir: CONFIG, roots: [ROOT, WT], exclude: new Set(), since: Date.now() - 600_000 }).map((s) => s.sessionId), [inWt.id]);
  assert.equal(listSessions({ claudeDir: CONFIG, roots: [ROOT, WT], exclude: new Set(), limit: 1 }).length, 1);
});

test("adopt: a replyable run on the same session, first prompt as its prompt, the rest as events", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  assert.equal(meta.sessionId, s.id);
  assert.equal(meta.prompt, "Fix the login bug");
  assert.equal(meta.status, "succeeded");
  assert.equal(meta.turns, 1, "the next reply resumes the session");
  assert.equal(meta.trigger, "terminal");
  assert.equal(meta.cwd, ROOT);
  assert.equal(meta.endedAt, ts(3));
  assert.equal(meta.resultText, "Fixed it.");
  assert.equal(meta.toolCalls, 1);
  assert.ok(meta.adoptedFrom);
  const events = runs.events(meta.id);
  assert.deepEqual(events.map((e) => e.type), ["assistant", "user", "assistant"]);
  assert.throws(() => runs.adopt(readSessionInfo(s.file)!, "main"), /already a run/);
});

test("absorbTerminal: what's said in the terminal afterwards becomes events, once", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  assert.equal(runs.absorbTerminal(meta.id), null, "nothing new");

  append(s.file, ROOT, [
    { type: "user", uuid: uid(), timestamp: ts(10), message: { content: "Now add a test" } },
    { type: "assistant", uuid: uid(), timestamp: ts(11), message: { content: [{ type: "text", text: "Added." }] } },
  ], Date.now());
  const after = runs.absorbTerminal(meta.id)!;
  assert.equal(after.endedAt, ts(11));
  assert.equal(after.terminalActivityAt, new Date(fs.statSync(s.file).mtimeMs).toISOString(), "when the terminal last wrote the file");
  assert.equal(after.resultText, "Added.");
  const events = runs.events(meta.id);
  assert.deepEqual(events.slice(-2).map((e) => e.text ?? e.message?.content?.[0]?.text), ["Now add a test", "Added."]);
  assert.equal(runs.absorbTerminal(meta.id), null, "not added twice");
  assert.equal(runs.events(meta.id).length, events.length);
});

test("terminalBusy: no reply while the terminal is still writing the session", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  const now = Date.now();
  assert.equal(runs.terminalBusy(meta, now), null, "quiet for an hour");

  // Typed in the terminal 30 s ago, not read in yet.
  append(s.file, ROOT, [{ type: "user", uuid: uid(), timestamp: new Date(now - 30_000).toISOString(), message: { content: "more" } }], now - 30_000);
  assert.match(runs.terminalBusy(runs.get(meta.id)!, now)!, /still open in a terminal/);
  assert.throws(() => runs.reply(meta.id, "hello"), /still open in a terminal/);

  // The refused reply read it in first: still busy until it's been quiet long enough.
  const absorbed = runs.get(meta.id)!;
  assert.equal(runs.events(meta.id).at(-1)?.text, "more");
  assert.match(runs.terminalBusy(absorbed, now)!, /still open/);
  assert.equal(runs.terminalBusy(absorbed, now + TERMINAL_QUIET_MS), null);

  // A run that wasn't adopted never is.
  assert.equal(runs.terminalBusy({ ...absorbed, adoptedFrom: null }, now), null);
});

test("readSessionInfo: a first prompt bigger than the usual head (a pasted screenshot) is still found", () => {
  const big = "x".repeat(400 * 1024);
  const s = writeSession(ROOT, { lines: [
    { cwd: ROOT, entrypoint: "cli", type: "user", uuid: uid(), timestamp: ts(0), message: { content: [{ type: "image", source: { data: big } }, { type: "text", text: "why is this broken?" }] } },
    { cwd: ROOT, type: "assistant", uuid: uid(), timestamp: ts(1), message: { content: [{ type: "text", text: "Because." }] } },
  ] });
  assert.equal(readSessionInfo(s.file)?.firstPrompt, "why is this broken?");
});

test("findSession: one of the workspace's sessions by id, not a sibling folder's or a made-up id", () => {
  const mine = writeSession(WT);
  const other = writeSession(SIBLING);
  const roots = [ROOT, WT];
  assert.equal(findSession({ claudeDir: CONFIG, roots, sessionId: mine.id })?.file, mine.file);
  assert.equal(findSession({ claudeDir: CONFIG, roots, sessionId: other.id }), null);
  assert.equal(findSession({ claudeDir: CONFIG, roots, sessionId: "../../etc/passwd" }), null);
});

test("absorbTerminal: reads only what's new, and a line that isn't an event doesn't make it read again", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  const offset = meta.adoptedFrom!.offset!;
  assert.equal(offset, fs.statSync(s.file).size);

  // Claude Code adds a title line later: read once, nothing added, cursor moves.
  fs.appendFileSync(s.file, JSON.stringify({ type: "ai-title", aiTitle: "Later title", sessionId: s.id }) + "\n");
  const later = Date.now() - 600_000;
  fs.utimesSync(s.file, new Date(later), new Date(later));
  assert.equal(runs.absorbTerminal(meta.id), null);
  const after = runs.get(meta.id)!;
  assert.equal(after.adoptedFrom!.offset, fs.statSync(s.file).size);
  assert.equal(after.adoptedFrom!.readAt, fs.statSync(s.file).mtimeMs);
  assert.equal(runs.terminalBusy(after), null, "a line read in, ten minutes old, doesn't hold replies");

  // A line still being written (no newline yet) waits for the next read.
  fs.appendFileSync(s.file, JSON.stringify({ cwd: ROOT, isSidechain: false, type: "user", uuid: uid(), timestamp: ts(20), message: { content: "half" } }));
  fs.utimesSync(s.file, new Date(later + 1000), new Date(later + 1000));
  assert.equal(runs.absorbTerminal(meta.id), null);
  fs.appendFileSync(s.file, "\n");
  fs.utimesSync(s.file, new Date(later + 2000), new Date(later + 2000));
  assert.equal(runs.absorbTerminal(meta.id)?.endedAt, ts(20));
});

test("continuation: an adopted run takes the terminal's lines in as events, never as a continuation", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  append(s.file, ROOT, [{ type: "user", uuid: uid(), timestamp: ts(30), message: { content: "from the terminal" } }], Date.now());
  const c = runs.continuation(meta.id)!;
  assert.deepEqual(c.events, []);
  assert.equal(c.lastActivityAt, new Date(fs.statSync(s.file).mtimeMs).toISOString());
  assert.equal(runs.events(meta.id).at(-1)?.text, "from the terminal");
  assert.ok(!runs.get(meta.id)!.continuedAt, "not tagged as continued in a terminal");
});

test("a session that starts with /clear is named and prompted by what was asked next", () => {
  const s = writeSession(ROOT, { lines: [
    { cwd: ROOT, entrypoint: "cli", type: "user", uuid: uid(), timestamp: ts(0), message: { content: "<command-name>/clear</command-name><command-args></command-args>" } },
    { cwd: ROOT, type: "user", uuid: uid(), timestamp: ts(1), message: { content: "Why is CI red?" } },
    { cwd: ROOT, type: "assistant", uuid: uid(), timestamp: ts(2), message: { content: [{ type: "text", text: "A flaky test." }] } },
  ] });
  const info = readSessionInfo(s.file)!;
  assert.equal(info.firstPrompt, "Why is CI red?");
  const meta = new RunManager(ledger()).adopt(info, "main");
  assert.equal(meta.prompt, "Why is CI red?");
});

test("absorbTerminal: a terminal batch starts with a divider and counts its tool calls", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  append(s.file, ROOT, [
    { type: "user", uuid: uid(), timestamp: ts(40), message: { content: "run the tests" } },
    { type: "assistant", uuid: uid(), timestamp: ts(41), message: { content: [{ type: "tool_use", id: "t9", name: "Bash", input: {} }] } },
  ], Date.now());
  const after = runs.absorbTerminal(meta.id)!;
  assert.equal(after.toolCalls, meta.toolCalls + 1);
  assert.equal(after.resultText, meta.resultText, "no new text: the last answer stays");
  const evs = runs.events(meta.id);
  assert.deepEqual(evs.slice(-3).map((e) => e.type), ["divider", "human", "assistant"]);
});

test("Send to hosted: an adopted run brings its terminal's last lines, and waits while that terminal is going", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  append(s.file, ROOT, [{ type: "user", uuid: uid(), timestamp: new Date().toISOString(), message: { content: "just now" } }], Date.now());
  assert.throws(() => runs.beginSend(meta.id), /still open in a terminal/);
  assert.equal(runs.events(meta.id).at(-1)?.text, "just now", "read in before refusing");
  assert.ok(!runs.get(meta.id)!.handoffPendingAt);
});

test("continuation: an adopted run continued in a terminal from here shows that like any other run", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  runs.handOff(meta.id);
  append(s.file, ROOT, [{ type: "user", uuid: uid(), timestamp: new Date(Date.now() + 1000).toISOString(), message: { content: "after continuing" } }], Date.now() + 1000);
  assert.deepEqual(runs.continuation(meta.id)!.events.map((e) => e.text), ["after continuing"]);
});

test("runPermission: no more than the session had; its default mode is manual, never a dontAsk it didn't have", () => {
  assert.deepEqual(runPermission("plan"), { permissionMode: "manual", planMode: true });
  assert.deepEqual(runPermission("acceptEdits"), { permissionMode: "acceptEdits", planMode: false });
  assert.deepEqual(runPermission("auto"), { permissionMode: "auto", planMode: false });
  assert.deepEqual(runPermission("dontAsk"), { permissionMode: "dontAsk", planMode: false });
  assert.deepEqual(runPermission("default"), { permissionMode: "manual", planMode: false });
  assert.deepEqual(runPermission("manual"), { permissionMode: "manual", planMode: false });
  assert.deepEqual(runPermission(null), { permissionMode: "manual", planMode: false }, "none recorded: not dontAsk (can't even read a file) nor auto (more than it had)");
  assert.deepEqual(runPermission("bypassPermissions"), { permissionMode: "auto", planMode: false });
});

test("adopt: the session's permission mode (its last) carries over", () => {
  const s = writeSession(ROOT);
  fs.appendFileSync(s.file, JSON.stringify({ type: "permission-mode", permissionMode: "plan", sessionId: s.id }) + String.fromCharCode(10));
  const meta = new RunManager(ledger()).adopt(readSessionInfo(s.file)!, "main");
  assert.equal(meta.planMode, true);
  assert.equal(meta.permissionMode, "manual", "plan switched off later: the default mode, not more");
});

test("adopt: a mode recorded only on the prompts is read, the terminal's own and not a dashboard turn's", () => {
  // As Claude Code writes it now: `permissionMode` on each user line, no permission-mode line.
  const s = writeSession(ROOT, { lines: [
    { cwd: ROOT, entrypoint: "cli", type: "user", uuid: uid(), timestamp: ts(0), permissionMode: "acceptEdits", message: { content: "Fix the login bug" } },
    { cwd: ROOT, entrypoint: "cli", type: "assistant", uuid: uid(), timestamp: ts(1), message: { content: [{ type: "text", text: "Done." }] } },
    { cwd: ROOT, entrypoint: "sdk-cli", type: "user", uuid: uid(), timestamp: ts(2), permissionMode: "dontAsk", message: { content: "a dashboard turn" } },
  ] });
  assert.equal(readSessionInfo(s.file)!.permissionMode, "acceptEdits");
  assert.equal(new RunManager(ledger()).adopt(readSessionInfo(s.file)!, "main").permissionMode, "acceptEdits");
});

test("listSessions startedSince: older sessions written lately don't crowd out a new one", () => {
  const roots = [path.join(ROOT, "crowd")];
  const fresh = writeSession(roots[0], { at: Date.now() - 120_000 });
  for (let i = 0; i < 3; i++) writeSession(roots[0], { at: Date.now() - 1000 }); // started ts(0): long ago, written just now
  const since = Date.parse(ts(0)) + 1;
  // Make the fresh one look new: its first line's timestamp is now.
  const lines = fs.readFileSync(fresh.file, "utf-8").split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l));
  const now = new Date().toISOString();
  fs.writeFileSync(fresh.file, lines.map((l) => JSON.stringify(l.timestamp ? { ...l, timestamp: now } : l)).join(String.fromCharCode(10)) + String.fromCharCode(10));
  const list = listSessions({ claudeDir: CONFIG, roots, exclude: new Set(), startedSince: since, limit: 1 });
  assert.deepEqual(list.map((x) => x.sessionId), [fresh.id]);
});

test("reply: an adopted run takes in its terminal's lines before the turn moves endedAt past them", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  // Said in the terminal ten minutes ago (quiet now), never swept in.
  const at = Date.now() - 600_000;
  append(s.file, ROOT, [{ type: "user", uuid: uid(), timestamp: new Date(at).toISOString(), message: { content: "said while nobody looked" } }], at);
  try { runs.reply(meta.id, "carry on"); } catch { /* no claude here: the turn may fail to start */ }
  assert.ok(runs.events(meta.id).some((e) => e.text === "said while nobody looked"));
  for (const r of runs.live.values()) r.child.kill();
});

test("absorbTerminal: what the terminal said during a dashboard turn is kept; the turn's own lines aren't added twice", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  // As a dashboard turn would leave it: its own lines (claude -p) and, meanwhile, a terminal exchange, all before the turn's end.
  const turnEnd = new Date(Date.now() - 600_000).toISOString();
  append(s.file, ROOT, [
    { entrypoint: "sdk-cli", type: "user", uuid: uid(), timestamp: ts(50), message: { content: "dashboard reply" } },
    { type: "user", uuid: uid(), timestamp: ts(51), message: { content: "typed meanwhile" } },
    { entrypoint: "sdk-cli", type: "assistant", uuid: uid(), timestamp: ts(52), message: { content: [{ type: "text", text: "dashboard answer" }] } },
  ], Date.now() - 600_000);
  const m = runs.get(meta.id)!;
  m.endedAt = turnEnd;
  fs.writeFileSync(path.join(runs.runsDir, meta.id + ".json"), JSON.stringify(m));
  runs.absorbTerminal(meta.id);
  const texts = runs.events(meta.id).map((e) => e.text ?? e.message?.content?.[0]?.text);
  assert.ok(texts.includes("typed meanwhile"));
  assert.ok(!texts.includes("dashboard reply") && !texts.includes("dashboard answer"));
});

test("absorbTerminal: one divider for a stretch in the terminal; a question answered there no longer stands", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  const m = runs.get(meta.id)!;
  m.status = "waiting"; m.question = [{ question: "Which?", header: "", multiSelect: false, options: [] }] as any;
  fs.writeFileSync(path.join(runs.runsDir, meta.id + ".json"), JSON.stringify(m));
  const t0 = Date.now() - 900_000;
  append(s.file, ROOT, [{ type: "user", uuid: uid(), timestamp: new Date(t0).toISOString(), message: { content: "the first one" } }], t0);
  runs.absorbTerminal(meta.id);
  append(s.file, ROOT, [{ type: "assistant", uuid: uid(), timestamp: new Date(t0 + 1000).toISOString(), message: { content: [{ type: "text", text: "ok" }] } }], t0 + 1000);
  const after = runs.absorbTerminal(meta.id)!;
  assert.equal(runs.events(meta.id).filter((e) => e.type === "divider").length, 1);
  assert.equal(after.status, "succeeded");
  assert.equal(after.question, null);
});

test("terminalBusy: a tool still running in the terminal holds replies past the quiet time, and Continue in terminal too", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  const t = Date.now() - 5 * 60_000; // five minutes into a long Bash call
  append(s.file, ROOT, [
    { type: "user", uuid: uid(), timestamp: new Date(t - 1000).toISOString(), message: { content: "run the slow suite" } },
    { type: "assistant", uuid: uid(), timestamp: new Date(t).toISOString(), message: { content: [{ type: "tool_use", id: "slow", name: "Bash", input: {} }] } },
  ], t);
  const after = runs.absorbTerminal(meta.id)!;
  assert.deepEqual(after.adoptedFrom!.pendingTools, ["slow"]);
  assert.match(runs.terminalBusy(after)!, /still running a tool/);
  assert.throws(() => runs.handOff(meta.id), /still running a tool/);
  assert.equal(runs.terminalBusy(after, Date.now() + 30 * 60_000), null, "not forever: a terminal closed mid-tool");
});

test("terminalBusy: with two tools running at once, the first result doesn't make it quiet", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  const t = Date.now() - 5 * 60_000;
  append(s.file, ROOT, [
    { type: "user", uuid: uid(), timestamp: new Date(t - 2000).toISOString(), message: { content: "two slow things" } },
    { type: "assistant", uuid: uid(), timestamp: new Date(t - 1000).toISOString(), message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: {} }, { type: "tool_use", id: "b", name: "Bash", input: {} }] } },
    { type: "user", uuid: uid(), timestamp: new Date(t).toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "a", content: "done" }] } },
  ], t);
  const after = runs.absorbTerminal(meta.id)!;
  assert.deepEqual(after.adoptedFrom!.pendingTools, ["b"]);
  assert.match(runs.terminalBusy(after)!, /still running a tool/);
});

test("absorbTerminal: a session file rewritten from the start doesn't add what the run already has", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  const before = runs.events(meta.id).length;
  // Rewritten shorter (a restore), then one new terminal line.
  const lines = fs.readFileSync(s.file, "utf-8").split(String.fromCharCode(10)).filter(Boolean).slice(1);
  fs.writeFileSync(s.file, lines.slice(0, 2).join(String.fromCharCode(10)) + String.fromCharCode(10));
  append(s.file, ROOT, [{ type: "user", uuid: uid(), timestamp: new Date().toISOString(), message: { content: "after the restore" } }], Date.now());
  runs.absorbTerminal(meta.id);
  const evs = runs.events(meta.id);
  assert.equal(evs.filter((e) => e.type !== "divider").length, before + 1);
  assert.equal(evs.at(-1)?.text, "after the restore");
});

test("absorbTerminal: a held queue stays held; the run's status isn't flipped to one that sends it", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  const m = runs.get(meta.id)!;
  m.status = "cancelled"; m.queued = [{ id: "q1", text: "later", at: new Date().toISOString() }];
  fs.writeFileSync(path.join(runs.runsDir, meta.id + ".json"), JSON.stringify(m));
  const t = Date.now() - 600_000;
  append(s.file, ROOT, [{ type: "user", uuid: uid(), timestamp: new Date(t).toISOString(), message: { content: "in the terminal" } }], t);
  assert.equal(runs.absorbTerminal(meta.id)!.status, "cancelled");
});

test("listSessions: a short session whose answer sits between a huge request line and a long tail is still listed", () => {
  const roots = [path.join(ROOT, "blob")];
  const id = uid();
  const dir = path.join(CONFIG, "projects", projectFolder(roots[0]));
  fs.mkdirSync(dir, { recursive: true });
  const b = { sessionId: id, cwd: roots[0], entrypoint: "cli", isSidechain: false };
  const lines = [
    { ...b, type: "user", uuid: uid(), timestamp: ts(0), message: { content: "this is just a test" } },
    // As Claude Code writes the whole request: one line far bigger than the head, its JSON escaped inside.
    { type: "api-request-blob", blob: JSON.stringify({ type: "assistant", text: "x".repeat(300 * 1024) }) },
    { ...b, type: "assistant", uuid: uid(), timestamp: ts(1), message: { content: [{ type: "text", text: "Got it." }] } },
    { type: "cost-state", pad: "y".repeat(100 * 1024) },
  ];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join(String.fromCharCode(10)) + String.fromCharCode(10));
  assert.deepEqual(listSessions({ claudeDir: CONFIG, roots, exclude: new Set() }).map((s) => s.label), ["this is just a test"]);

  // Never answered, same shape: still left out (the escaped "assistant" inside the blob doesn't count).
  const id2 = uid();
  const file2 = path.join(dir, `${id2}.jsonl`);
  fs.writeFileSync(file2, [lines[0], lines[1], lines[3]].map((l) => JSON.stringify({ ...l, sessionId: id2 })).join(String.fromCharCode(10)) + String.fromCharCode(10));
  assert.equal(readSessionInfo(file2), null);
});

const OLD = path.join(os.tmpdir(), "dash-sessions-ws", "old-project");

test("suggestFolders: other folders Claude Code was used in, a repo inside one folded into it, the workspace and script-only folders left out", () => {
  writeSession(OLD, { at: Date.now() - 5000 });
  writeSession(path.join(OLD, "api"), { at: Date.now() - 1000 });
  writeSession(path.join(os.tmpdir(), "dash-sessions-ws", "scripts-only"), { entrypoint: "sdk-cli" });
  const list = suggestFolders(CONFIG, [ROOT]);
  const old = list.find((f) => f.path === OLD);
  assert.ok(old, "the old project is offered");
  assert.equal(old!.sessions >= 2, true, "its api folder's sessions count towards it");
  assert.ok(!list.some((f) => f.path === path.join(OLD, "api")), "not offered on its own");
  assert.ok(!list.some((f) => isInside(ROOT, f.path)), "nothing in the workspace");
  assert.ok(!list.some((f) => f.path.endsWith("scripts-only")));
});

test("forkSession: a copy under a new id in the workspace's project folder, the original untouched", () => {
  const s = writeSession(OLD);
  fs.mkdirSync(path.join(path.dirname(s.file), s.id, "subagents"), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(s.file), s.id, "subagents", "a.jsonl"), "{}");
  const before = fs.readFileSync(s.file, "utf-8");
  const newId = "99999999-0000-4000-8000-000000000001";
  const copy = forkSession(readSessionInfo(s.file)!, ROOT, CONFIG, newId);
  assert.equal(copy.sessionId, newId);
  assert.equal(path.dirname(copy.file), path.join(CONFIG, "projects", projectFolder(ROOT)));
  assert.ok(!fs.readFileSync(copy.file, "utf-8").includes(s.id), "every line's sessionId rewritten");
  assert.ok(fs.existsSync(path.join(path.dirname(copy.file), newId, "subagents", "a.jsonl")), "side folder copied");
  assert.equal(fs.readFileSync(s.file, "utf-8"), before);
  assert.throws(() => forkSession(readSessionInfo(s.file)!, ROOT, CONFIG, newId), /already there/);
});

test("moveIn: an ordinary run in the workspace, told where it came from; it can go to the hosted dashboard", () => {
  const s = writeSession(OLD);
  const copy = forkSession(readSessionInfo(s.file)!, ROOT, CONFIG, "99999999-0000-4000-8000-000000000002");
  const runs = new RunManager(ledger());
  const meta = runs.moveIn(copy, { workspace: "main", cwd: ROOT, fromCwd: OLD, fromSession: s.id });
  assert.equal(meta.movedFrom?.session, s.id);
  assert.equal(meta.sessionId, copy.sessionId);
  assert.equal(meta.cwd, ROOT);
  assert.equal(meta.trigger, "terminal:moved");
  assert.equal(meta.adoptedFrom, null, "no terminal to follow: it's the dashboard's now");
  assert.deepEqual(meta.movedFrom?.cwd, OLD);
  assert.match(meta.extraPrompt!, /moved here from another folder/);
  assert.equal(meta.prompt, "Fix the login bug");
  assert.ok(runs.beginSend(meta.id).handoffPendingAt);
  const again = forkSession(readSessionInfo(s.file)!, ROOT, CONFIG, "99999999-0000-4000-8000-000000000003");
  assert.throws(() => runs.moveIn(again, { workspace: "main", cwd: ROOT, fromCwd: OLD, fromSession: s.id }), /moved here already/);
});

test("terminalBusy: lines with no entrypoint written after the last turn from here still count as the terminal's", () => {
  const s = writeSession(ROOT);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main");
  // An older Claude Code, or a title line: no entrypoint, written 20 s ago, well after the run's last activity.
  const t = Date.now() - 20_000;
  fs.appendFileSync(s.file, JSON.stringify({ type: "ai-title", aiTitle: "Renamed", sessionId: s.id }) + String.fromCharCode(10));
  fs.utimesSync(s.file, new Date(t), new Date(t));
  assert.equal(runs.absorbTerminal(meta.id), null, "nothing to show");
  assert.match(runs.terminalBusy(runs.get(meta.id)!)!, /still open in a terminal/);
});

test("adopt from another folder: Send to hosted says to move it first", () => {
  const s = writeSession(OLD);
  const runs = new RunManager(ledger());
  const meta = runs.adopt(readSessionInfo(s.file)!, "main", "terminal", OLD);
  assert.equal(meta.adoptedFrom!.outside, OLD);
  assert.equal(meta.cwd, OLD, "keeps working where it is");
  assert.throws(() => runs.beginSend(meta.id), /outside the workspace.*Move it into this workspace/);
});
