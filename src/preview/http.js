// Local preview server: projects gallery, Superdesign-style canvas, live reload (SSE),
// a JSON API the canvas uses to queue requests for Claude, and critique reports.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, log } from '../config.js';
import * as ws from '../workspace.js';
import { renderCritique } from './critique.js';
import * as runner from '../runner.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

const state = {
  server: null, port: null, baseUrl: null,
  sse: new Set(),            // { res, slug }
  waiters: new Map(),        // slug -> number of Claude sessions waiting for feedback
  mtimes: new Map(),         // "slug/nodeId" -> mtimeMs, for edits made directly on disk
  token: crypto.randomBytes(24).toString('hex'), // guards /mcp (background Claude Code runs)
  mcpFactory: null,          // () => McpServer, set by the entry point
};

/** The entry point hands over a factory so background runs can talk to this same process over HTTP. */
export function setMcpFactory(fn) { state.mcpFactory = fn; }
export const mcpEndpoint = () => (state.baseUrl && state.mcpFactory ? { url: `${state.baseUrl}/mcp`, token: state.token } : null);
export const waitersOf = (slug) => state.waiters.get(slug) || 0;

export function previewInfo() { return { url: state.baseUrl, port: state.port, workspace: config.workspace }; }
// node goes in the query string: some OS URL handlers (Windows) drop #fragments
export const projectUrl = (slug, nodeId) => `${state.baseUrl}/p/${encodeURIComponent(slug)}${nodeId ? `?node=${encodeURIComponent(nodeId)}` : ''}`;
export const nodeUrl = (slug, node) => `${state.baseUrl}/f/${encodeURIComponent(slug)}/${node.file}`;
export const critiqueUrl = (slug, cid) => `${state.baseUrl}/c/${encodeURIComponent(slug)}/${cid}`;
export function viewersOf(slug) { let n = 0; for (const c of state.sse) if (!slug || c.slug === slug) n++; return n; }

export function setWaiting(slug, delta) {
  const n = Math.max(0, (state.waiters.get(slug) || 0) + delta);
  if (n) state.waiters.set(slug, n); else state.waiters.delete(slug);
  broadcast(slug, { type: 'listening', listening: n > 0 });
}

function broadcast(slug, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of state.sse) if (!c.slug || c.slug === slug) { try { c.res.write(data); } catch { /* closed */ } }
}

ws.events.on('change', (e) => broadcast(e.slug, { type: 'change', what: e.type }));

function nodeMtime(slug, node) {
  try { return Math.round(fs.statSync(ws.nodeFile(slug, node)).mtimeMs); } catch { return 0; }
}

async function projectPayload(slug) {
  const p = ws.loadProject(slug);
  for (const n of p.nodes) n.mtime = nodeMtime(slug, n);
  return { ...p, listening: (state.waiters.get(slug) || 0) > 0, dir: ws.projectDir(slug), runner: await runner.runnerInfo(slug) };
}

async function handleMcp(req, res) {
  if (req.headers.authorization !== `Bearer ${state.token}`) return send(res, 401, { error: 'unauthorized' });
  if (!state.mcpFactory) return send(res, 503, { error: 'MCP endpoint not ready' });
  if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  const body = await readBody(req, 50 * 1024 * 1024);
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const server = state.mcpFactory();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ---- file watching: live reload when Claude edits node files directly ----
function startWatching() {
  const onFile = (rel) => {
    if (!rel) return;
    const parts = rel.split(/[\\/]/);
    if (parts.length >= 3 && parts[1] === 'nodes' && parts[2].endsWith('.html')) {
      const slug = parts[0]; const id = parts[2].replace(/\.html$/, '');
      const key = `${slug}/${id}`;
      let m = 0; try { m = fs.statSync(path.join(config.workspace, rel)).mtimeMs; } catch { return; }
      if (state.mtimes.get(key) === m) return;
      state.mtimes.set(key, m);
      broadcast(slug, { type: 'change', what: 'file', node: id });
    } else if (parts.length >= 2 && (parts[1] === 'DESIGN.md' || parts[1].endsWith('.css'))) {
      broadcast(parts[0], { type: 'change', what: 'assets' });
    }
  };
  // fs.watch is fast but unreliable for folders created after it started (Linux) and on
  // network drives, so projects someone is looking at are also polled once a second.
  try {
    const w = fs.watch(config.workspace, { recursive: true }, (_e, f) => onFile(f?.toString()));
    w.on('error', () => {});
  } catch { /* polling below covers it */ }
  setInterval(() => {
    const slugs = new Set([...state.sse].map((c) => c.slug).filter(Boolean));
    for (const slug of slugs) {
      let files = [];
      try { files = fs.readdirSync(path.join(config.workspace, slug, 'nodes')); } catch { continue; }
      for (const f of files) {
        const key = `${slug}/${f.replace(/\.html$/, '')}`;
        if (!state.mtimes.has(key)) {
          // first sighting: remember without triggering a reload
          try { state.mtimes.set(key, fs.statSync(path.join(config.workspace, slug, 'nodes', f)).mtimeMs); } catch { /* gone */ }
          continue;
        }
        onFile(`${slug}/nodes/${f}`);
      }
    }
  }, 1000).unref();
}

// ---- helpers ----
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(data);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

/** Block cross-site requests and DNS rebinding: only our own host may call the API. */
function trusted(req) {
  const host = (req.headers.host || '').toLowerCase();
  const okHost = [`127.0.0.1:${state.port}`, `localhost:${state.port}`, `[::1]:${state.port}`];
  if (!okHost.includes(host)) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !okHost.some((h) => origin === `http://${h}`)) return false;
    if (!String(req.headers['content-type'] || '').includes('application/json')) return false;
  }
  return true;
}

function serveFile(res, file, { inject = null, cors = false } = {}) {
  const extra = cors ? { 'Access-Control-Allow-Origin': '*' } : {};
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (inject && ext === '.html') {
      let html = fs.readFileSync(file, 'utf8');
      const tag = `<script src="/_hub/inject.js" data-node="${inject.node}" data-slug="${inject.slug}"></script>`;
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tag}</body>`) : html + tag;
      return send(res, 200, html, type, extra);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store', ...extra });
    fs.createReadStream(file).pipe(res);
  });
}

function within(base, target) {
  const rel = path.relative(base, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---- routes ----
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!trusted(req)) return send(res, 403, { error: 'forbidden' });

  if (url.pathname === '/mcp') return handleMcp(req, res);
  if (url.pathname === '/' ) return serveFile(res, path.join(STATIC_DIR, 'index.html'));
  if (parts[0] === '_hub' && parts.length === 2) {
    const f = path.join(STATIC_DIR, parts[1]);
    if (!within(STATIC_DIR, f)) return send(res, 404, 'Not found', 'text/plain');
    return serveFile(res, f);
  }
  if (parts[0] === 'p' && parts.length === 2) return serveFile(res, path.join(STATIC_DIR, 'canvas.html'));
  if (parts[0] === 'c' && parts.length === 3) {
    try {
      const p = ws.loadProject(parts[1]);
      const c = p.critiques.find((x) => x.id === parts[2]);
      if (!c) return send(res, 404, 'Critique not found', 'text/plain');
      return send(res, 200, renderCritique(p, c), 'text/html; charset=utf-8');
    } catch (e) { return send(res, 404, e.message, 'text/plain'); }
  }
  if (parts[0] === 'f' && parts.length >= 3) {
    const base = ws.projectDir(parts[1]);
    const file = path.resolve(base, ...parts.slice(2));
    if (!within(base, file)) return send(res, 403, 'Forbidden', 'text/plain');
    const inject = url.searchParams.get('hub') === '1' && parts[2] === 'nodes' ? { slug: parts[1], node: path.basename(file, '.html') } : null;
    return serveFile(res, file, { inject, cors: true });
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    const client = { res, slug: url.searchParams.get('slug') || null };
    state.sse.add(client);
    if (client.slug) res.write(`data: ${JSON.stringify({ type: 'listening', listening: (state.waiters.get(client.slug) || 0) > 0 })}\n\n`);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
    req.on('close', () => { clearInterval(ping); state.sse.delete(client); });
    return;
  }

  // ---- JSON API ----
  if (parts[0] !== 'api') return send(res, 404, 'Not found', 'text/plain');
  try {
    if (parts[1] === 'ping') return send(res, 200, { app: 'design-hub', workspace: config.workspace, pid: process.pid });
    if (parts[1] === 'runner' && req.method === 'POST') {
      const body = await readBody(req);
      runner.setRunnerEnabled(Boolean(body.enabled));
      return send(res, 200, { enabled: runner.runnerEnabled() });
    }
    if (parts[1] === 'projects' && req.method === 'GET') {
      return send(res, 200, ws.listProjects().map((p) => {
        const show = p.nodes.find((n) => n.id === p.selected) || p.nodes[p.nodes.length - 1] || null;
        return { slug: p.slug, name: p.name, status: p.status, brief: p.brief, updatedAt: p.updatedAt, nodes: p.nodes.length, pending: p.requests.filter((r) => r.status === 'pending').length, thumb: show ? { file: show.file, viewport: show.viewport, rev: show.revision } : null, designSystem: p.designSystem?.title || null };
      }));
    }
    if (parts[1] === 'p' && parts[2]) {
      const slug = parts[2];
      const [, , , section, id, action] = parts;
      if (!section && req.method === 'GET') return send(res, 200, await projectPayload(slug));
      const body = req.method === 'GET' ? {} : await readBody(req);
      if (section === 'requests' && !id && req.method === 'POST') {
        const r = ws.addRequest(slug, body);
        return send(res, 201, r);
      }
      if (section === 'requests' && id && action === 'dismiss') { ws.dismissRequest(slug, id); return send(res, 200, { ok: true }); }
      if (section === 'requests' && id && action === 'retry') { ws.retryRequest(slug, id); return send(res, 200, { ok: true }); }
      if (section === 'nodes' && id && action === 'duplicate') { const { node } = ws.duplicateNode(slug, id); return send(res, 201, node); }
      if (section === 'nodes' && id && req.method === 'DELETE') { ws.deleteNode(slug, id); return send(res, 200, { ok: true }); }
      if (section === 'nodes' && id && req.method === 'PATCH') { ws.updateNodeMeta(slug, id, body); return send(res, 200, { ok: true }); }
      if (section === 'select') { ws.selectNode(slug, body.nodeId); return send(res, 200, { ok: true }); }
      if (section === 'runner' && id === 'stop') { return send(res, 200, { stopped: runner.stop(slug) }); }
      if (section === 'runner' && id === 'run') { runner.schedule(slug, 0); return send(res, 200, { ok: true }); }
      if (section === 'status') { ws.setStatus(slug, body.status, body.nodeId); return send(res, 200, { ok: true }); }
      if (section === 'design-md' && req.method === 'GET') {
        const f = path.join(ws.projectDir(slug), 'DESIGN.md');
        return send(res, 200, { exists: fs.existsSync(f), text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8').slice(0, 60000) : '' });
      }
    }
    return send(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
}

export function startPreview() {
  if (state.server) return Promise.resolve(previewInfo());
  return new Promise((resolve, reject) => {
    let port = config.port;
    const maxPort = config.port + 30;
    const server = http.createServer((req, res) => { handle(req, res).catch((e) => send(res, 500, { error: e.message })); });
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && port < maxPort) { port++; server.listen(port, config.host); }
      else reject(e);
    });
    server.on('listening', () => {
      state.server = server; state.port = port;
      state.baseUrl = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`;
      startWatching();
      runner.configureRunner({ waiters: waitersOf, endpoint: mcpEndpoint });
      runner.startRunner();
      log(`preview at ${state.baseUrl} (workspace ${config.workspace})`);
      resolve(previewInfo());
    });
    server.listen(port, config.host);
  });
}
