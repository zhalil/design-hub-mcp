// Background Claude Code runs: when the user sends a request from the canvas and no interactive
// Claude Code session is waiting for it, start headless Claude Code (`claude -p`) under the user's
// own login (subscription) and let it handle the request through this same MCP server over HTTP.
// Design Hub itself never calls a model API.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { config, readJson, writeJson, log } from './config.js';
import * as ws from './workspace.js';

const STATE = () => path.join(config.stateDir, 'runner.json');
const MAX_LOG = 80;
const RUN_TIMEOUT_MS = Number(process.env.DESIGN_HUB_RUNNER_TIMEOUT_MIN || 20) * 60 * 1000;

const runs = new Map();       // slug -> active run
const lastRuns = new Map();   // slug -> finished run summary
const timers = new Map();     // slug -> debounce timer
let claudeBin = null;         // { cmd, shell, version } | { error }
let hooks = { waiters: () => 0, endpoint: () => null };

export function configureRunner(h) { hooks = { ...hooks, ...h }; }

export function runnerEnabled() {
  const st = readJson(STATE(), {});
  if (typeof st.enabled === 'boolean') return st.enabled;
  return !/^(off|0|false|no)$/i.test(process.env.DESIGN_HUB_RUNNER || '');
}

export function setRunnerEnabled(enabled) {
  writeJson(STATE(), { ...readJson(STATE(), {}), enabled: Boolean(enabled) });
  for (const slug of ws.listProjects().map((p) => p.slug)) ws.events.emit('change', { slug, type: 'runner' });
}

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true, shell: opts.shell || false, env: cleanEnv() }, (err, stdout, stderr) => resolve({ err, out: `${stdout || ''}${stderr || ''}`.trim() }));
  });
}

/** Locate the Claude Code CLI. On Windows an npm install is a .cmd shim that needs a shell. */
export async function findClaude(force = false) {
  if (claudeBin && !force) return claudeBin;
  const explicit = process.env.DESIGN_HUB_CLAUDE;
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.platform === 'win32') {
    const { out } = await sh('where', ['claude']);
    // only real executables: `where` also lists the extension-less npm shell script, which Windows can't run
    candidates.push(...out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /\.(exe|cmd|bat)$/i.test(l)));
    const home = process.env.USERPROFILE || '';
    candidates.push(path.join(home, '.local', 'bin', 'claude.exe'));
  } else {
    candidates.push('claude');
    const home = process.env.HOME || '';
    candidates.push(path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  }
  for (const c of candidates) {
    const shell = process.platform === 'win32' && !/\.exe$/i.test(c);
    const cmd = shell ? `"${c}"` : c;
    if (!shell && path.isAbsolute(c) && !fs.existsSync(c)) continue;
    const { err, out } = await sh(cmd, ['--version'], { shell });
    if (!err && /\d+\.\d+/.test(out)) { claudeBin = { cmd, shell, path: c, version: out.split('\n')[0] }; return claudeBin; }
  }
  claudeBin = { error: 'Claude Code CLI ("claude") not found. Install Claude Code and sign in with your subscription (`claude` → /login), or set DESIGN_HUB_CLAUDE to its path.' };
  return claudeBin;
}

/**
 * Environment for the background run: force the subscription login and allow nesting.
 * - API key variables are removed so the run can never bill an API key.
 * - CLAUDECODE / entrypoint markers are removed: they make a nested `claude` refuse to start.
 */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  // if the run loads the Design Hub plugin too, its server copy must stay idle (see server.js)
  env.DESIGN_HUB_WORKER = '1';
  return env;
}

function quoteWin(a) { return /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a; }

function summarizeTool(name, input = {}) {
  const short = name.replace(/^mcp__design-hub__/, '');
  const hint = input.label || input.query || input.id || input.node || input.file_path || input.pattern || '';
  return `${short}${hint ? ` · ${String(hint).slice(0, 60)}` : ''}`;
}

function buildPrompt(p, requests) {
  const items = requests.map((r) => {
    const n = r.nodeId ? p.nodes.find((x) => x.id === r.nodeId) : null;
    return {
      request_id: r.id, type: r.type, text: r.text, count: r.count || undefined, element: r.element || undefined,
      node: n ? { id: n.id, label: n.label, viewport: n.viewport, file: ws.nodeFile(p.slug, n) } : null,
    };
  });
  return `You are Claude Code running in the background for the Design Hub canvas. The user is looking at the canvas in their browser, not at this chat, so everything you produce must go onto the canvas through the design-hub tools.

Project: "${p.slug}" (${p.name}). Brief: ${p.brief || '—'}
Requests sent from the canvas, handle them in order:
${JSON.stringify(items, null, 2)}

How to work:
1. Call hub_workflow once, then project_get. DESIGN.md (if present) is the only source of tokens — read it before changing anything.
2. For each request read the target node's file, then save the result with design_write (project "${p.slug}", parent = the request's node id, request_id = the request id, a short label):
   - element: change only that element (selector given), keep everything else byte-identical;
   - iterate: apply the change to the whole design;
   - variations: write N distinct variations as siblings with the same parent (no parent if there is no node: N new directions);
   - pick: the user chose that node; if there is no DESIGN.md yet, write one for it with design_md_set.
   If a request needs a new layout, use catalog_search / catalog_get for a fitting template and its rules.
3. Run design_lint on every node you wrote. Fix P0 issues your change introduced (design_write node=<id>). For an "element" request do not touch other P0 issues — mention them in the reply instead.
4. Call feedback_resolve for each request with result_nodes and a one-sentence reply in the language the user wrote in.
Do not call canvas_wait_feedback. Do not edit files directly — only through design-hub tools. Then stop.`;
}

function pushLog(run, line) {
  run.log.push({ t: Date.now(), line: String(line).replace(/\s+/g, ' ').slice(0, 300) });
  if (run.log.length > MAX_LOG) run.log.splice(0, run.log.length - MAX_LOG);
  const now = Date.now();
  if (now - (run.lastEmit || 0) > 400) { run.lastEmit = now; ws.events.emit('change', { slug: run.slug, type: 'runner' }); }
  else { clearTimeout(run.emitTimer); run.emitTimer = setTimeout(() => ws.events.emit('change', { slug: run.slug, type: 'runner' }), 450); }
}

function handleEvent(run, ev) {
  if (ev.type === 'system' && ev.subtype === 'init') {
    pushLog(run, `Claude Code started${ev.model ? ` (${ev.model})` : ''}`);
    if (ev.apiKeySource && ev.apiKeySource !== 'none') pushLog(run, `auth: ${ev.apiKeySource}`);
  } else if (ev.type === 'assistant') {
    for (const c of ev.message?.content || []) {
      if (c.type === 'tool_use') pushLog(run, `→ ${summarizeTool(c.name, c.input)}`);
      else if (c.type === 'text' && c.text?.trim()) pushLog(run, c.text.trim());
    }
  } else if (ev.type === 'result') {
    run.result = { ok: !ev.is_error && ev.subtype === 'success', subtype: ev.subtype, turns: ev.num_turns, durationMs: ev.duration_ms, text: (ev.result || '').slice(0, 500) };
    pushLog(run, run.result.ok ? `Done in ${Math.round((ev.duration_ms || 0) / 1000)}s` : `Stopped: ${ev.subtype}${ev.result ? ` — ${ev.result.slice(0, 160)}` : ''}`);
  }
}

async function start(slug) {
  if (runs.has(slug) || !runnerEnabled()) return;
  if (hooks.waiters(slug) > 0) return; // an interactive session will take it
  const bin = await findClaude();
  if (bin.error) { log(bin.error); return; }
  const endpoint = hooks.endpoint();
  if (!endpoint) return;
  const requests = ws.claimRequests(slug, 'runner');
  if (!requests.length) return;
  const p = ws.loadProject(slug);

  const cfgFile = path.join(config.stateDir, `runner-mcp-${process.pid}.json`);
  writeJson(cfgFile, { mcpServers: { 'design-hub': { type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` } } } });

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', cfgFile,
    '--allowedTools', 'mcp__design-hub,Read,Glob,Grep', '--max-turns', process.env.DESIGN_HUB_RUNNER_MAX_TURNS || '60'];
  const model = process.env.DESIGN_HUB_RUNNER_MODEL;
  if (model && model !== 'default') args.push('--model', model);
  // run in the repo that owns the workspace so the user's CLAUDE.md applies
  const cwd = fs.existsSync(path.dirname(config.workspace)) ? path.dirname(config.workspace) : process.cwd();

  const run = { slug, id: `run-${Date.now().toString(36)}`, requestIds: requests.map((r) => r.id), startedAt: new Date().toISOString(), log: [], child: null, result: null };
  runs.set(slug, run);
  pushLog(run, `Starting Claude Code for ${requests.length} request${requests.length > 1 ? 's' : ''} (your Claude subscription, no API key)`);

  const child = spawn(bin.cmd, bin.shell ? args.map(quoteWin) : args, { cwd, env: cleanEnv(), shell: bin.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  run.child = child;
  child.stdin.end(buildPrompt(p, requests));
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { handleEvent(run, JSON.parse(line)); } catch { pushLog(run, line); }
    }
  });
  let errTail = '';
  child.stderr.on('data', (d) => { errTail = (errTail + d.toString('utf8')).slice(-2000); });
  const killer = setTimeout(() => { pushLog(run, 'Timed out — stopping'); stop(slug); }, RUN_TIMEOUT_MS);
  child.on('error', (e) => pushLog(run, `Could not start Claude Code: ${e.message}`));
  child.on('close', (code) => {
    clearTimeout(killer);
    runs.delete(slug);
    if (code !== 0 && !run.result) pushLog(run, `Claude Code exited with code ${code}${errTail ? `: ${errTail.trim().split('\n').slice(-2).join(' ')}` : ''}`);
    // anything this run claimed but did not resolve goes back to the user as failed
    try {
      const fresh = ws.loadProject(slug);
      const open = fresh.requests.filter((r) => run.requestIds.includes(r.id) && r.status === 'claimed').map((r) => r.id);
      if (open.length) ws.resolveRequests(slug, open, { status: 'failed', reply: run.stopped ? 'Stopped.' : (run.result?.text || errTail.trim().split('\n').pop() || 'Claude Code finished without resolving this request.').slice(0, 300) });
    } catch (e) { log(`runner cleanup: ${e.message}`); }
    lastRuns.set(slug, { id: run.id, startedAt: run.startedAt, endedAt: new Date().toISOString(), result: run.result, stopped: Boolean(run.stopped), log: run.log.slice(-30) });
    ws.events.emit('change', { slug, type: 'runner' });
    // requests that arrived during the run
    if (ws.pendingRequests(slug).length) schedule(slug, 500);
  });
}

export function schedule(slug, delay = 2500) {
  clearTimeout(timers.get(slug));
  timers.set(slug, setTimeout(() => { timers.delete(slug); start(slug).catch((e) => log(`runner: ${e.message}`)); }, delay));
}

export function stop(slug) {
  const run = runs.get(slug);
  if (!run?.child) return false;
  run.stopped = true;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], () => {});
  else run.child.kill('SIGTERM');
  return true;
}

export async function runnerInfo(slug) {
  const bin = await findClaude();
  const active = runs.get(slug);
  return {
    enabled: runnerEnabled(),
    available: !bin.error,
    claude: bin.error ? null : bin.version,
    error: bin.error || null,
    running: active ? { id: active.id, startedAt: active.startedAt, requestIds: active.requestIds, log: active.log.slice(-30) } : null,
    last: lastRuns.get(slug) || null,
  };
}

/** Watch the request queue: hand new canvas requests to a background run if nobody is listening. */
export function startRunner() {
  ws.events.on('request', (e) => { if (runnerEnabled()) schedule(e.slug); });
  findClaude().then((b) => log(b.error ? `runner: ${b.error}` : `runner: Claude Code ${b.version} (${b.path})`));
}
