// Design projects: a canvas of design nodes (HTML files) forming iteration trees,
// a queue of requests coming from the browser canvas, critiques and status.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config, readJson, writeJson } from './config.js';

export const events = new EventEmitter();
events.setMaxListeners(100);

export const STATUSES = ['draft', 'review', 'ready'];
export const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
};

export function slugify(name) {
  const base = String(name || 'design').normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return translit(base) || 'design';
}

const RU = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
function translit(s) { return s.replace(/[а-яё]/g, (c) => RU[c] ?? ''); }

export const projectDir = (slug) => path.join(config.workspace, slug);
const projectFile = (slug) => path.join(projectDir(slug), 'project.json');

export function listProjects() {
  let dirs = [];
  try { dirs = fs.readdirSync(config.workspace, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  return dirs.map((d) => readJson(projectFile(d.name), null)).filter(Boolean)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function loadProject(slug) {
  const p = readJson(projectFile(slug), null);
  if (!p) {
    const known = listProjects().map((x) => x.slug);
    throw new Error(`Project "${slug}" not found.${known.length ? ' Known: ' + known.join(', ') : ' Create one with project_create.'}`);
  }
  p.nodes ??= []; p.requests ??= []; p.critiques ??= [];
  return p;
}

function save(p, event = 'project') {
  p.updatedAt = new Date().toISOString();
  writeJson(projectFile(p.slug), p);
  events.emit('change', { slug: p.slug, type: event });
  return p;
}

export function createProject({ name, brief = '', slug }) {
  let s = slugify(slug || name);
  if (fs.existsSync(projectFile(s))) {
    let i = 2;
    while (fs.existsSync(projectFile(`${s}-${i}`))) i++;
    s = `${s}-${i}`;
  }
  fs.mkdirSync(path.join(projectDir(s), 'nodes'), { recursive: true });
  const now = new Date().toISOString();
  const p = { slug: s, name: name || s, brief, status: 'draft', createdAt: now, updatedAt: now, designSystem: null, nodes: [], requests: [], critiques: [], seq: { node: 0, request: 0, critique: 0 } };
  return save(p, 'created');
}

function nextId(p, kind, prefix) {
  p.seq ??= { node: 0, request: 0, critique: 0 };
  p.seq[kind] = (p.seq[kind] || 0) + 1;
  return `${prefix}${p.seq[kind]}`;
}

export function nodeFile(slug, node) { return path.join(projectDir(slug), node.file); }

export function getNode(p, id) {
  const n = p.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`Node "${id}" not found in project ${p.slug}. Nodes: ${p.nodes.map((x) => x.id).join(', ') || 'none'}`);
  return n;
}

/** Create a new node (optionally a child of `parent`) or overwrite an existing node in place. */
export function writeNode(slug, { html, parent = null, node = null, label, note, viewport, origin = 'agent', requestId = null }) {
  const p = loadProject(slug);
  const now = new Date().toISOString();
  let n;
  if (node) {
    n = getNode(p, node);
    n.updatedAt = now;
    n.revision = (n.revision || 1) + 1;
    if (label) n.label = label;
    if (note) n.note = note;
    if (viewport) n.viewport = viewport;
  } else {
    if (parent) getNode(p, parent);
    const id = nextId(p, 'node', 'n');
    n = { id, label: label || (parent ? `Iteration of ${parent}` : `Design ${id.slice(1)}`), parent: parent || null, file: `nodes/${id}.html`, createdAt: now, updatedAt: now, revision: 1, viewport: viewport || inheritViewport(p, parent), note: note || '', origin, requestId };
    p.nodes.push(n);
  }
  fs.mkdirSync(path.join(projectDir(slug), 'nodes'), { recursive: true });
  fs.writeFileSync(nodeFile(slug, n), html);
  if (p.status === 'ready' && !node) p.status = 'review';
  save(p, node ? 'node-updated' : 'node-added');
  events.emit('node', { slug, node: n.id });
  return { project: p, node: n };
}

function inheritViewport(p, parent) {
  if (parent) return p.nodes.find((x) => x.id === parent)?.viewport || 'desktop';
  return 'desktop';
}

export function duplicateNode(slug, id) {
  const p = loadProject(slug);
  const src = getNode(p, id);
  const html = fs.readFileSync(nodeFile(slug, src), 'utf8');
  return writeNode(slug, { html, parent: src.id, label: `${src.label} (copy)`, viewport: src.viewport, origin: 'duplicate' });
}

export function deleteNode(slug, id) {
  const p = loadProject(slug);
  const n = getNode(p, id);
  // re-parent children to the deleted node's parent
  for (const c of p.nodes) if (c.parent === id) c.parent = n.parent;
  p.nodes = p.nodes.filter((x) => x.id !== id);
  if (p.selected === id) p.selected = null;
  const trash = path.join(projectDir(slug), '.trash');
  fs.mkdirSync(trash, { recursive: true });
  try { fs.renameSync(nodeFile(slug, n), path.join(trash, `${n.id}-${Date.now()}.html`)); } catch { /* already gone */ }
  return save(p, 'node-deleted');
}

export function updateNodeMeta(slug, id, patch) {
  const p = loadProject(slug);
  const n = getNode(p, id);
  for (const k of ['label', 'viewport', 'note']) if (patch[k] !== undefined) n[k] = patch[k];
  if (patch.x !== undefined && patch.y !== undefined) n.pos = { x: patch.x, y: patch.y };
  return save(p, 'node-meta');
}

export function setStatus(slug, status, nodeId) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  const p = loadProject(slug);
  if (nodeId) { getNode(p, nodeId); p.selected = nodeId; }
  p.status = status;
  return save(p, 'status');
}

export function selectNode(slug, nodeId) {
  const p = loadProject(slug);
  if (nodeId) getNode(p, nodeId);
  p.selected = nodeId || null;
  return save(p, 'selected');
}

export function setDesignSystem(slug, info) {
  const p = loadProject(slug);
  p.designSystem = info;
  return save(p, 'design-system');
}

// ---------- requests (feedback queue from the browser canvas) ----------

export const REQUEST_TYPES = ['iterate', 'element', 'variations', 'comment', 'pick'];

export function addRequest(slug, { type, nodeId = null, text = '', element = null, count = null, viewport = null }) {
  if (!REQUEST_TYPES.includes(type)) throw new Error(`bad request type ${type}`);
  const p = loadProject(slug);
  if (nodeId) getNode(p, nodeId);
  const r = { id: nextId(p, 'request', 'r'), type, nodeId, text: String(text || '').slice(0, 4000), element, count, viewport, status: 'pending', createdAt: new Date().toISOString() };
  if (type === 'pick') p.selected = nodeId;
  p.requests.push(r);
  save(p, 'request');
  events.emit('request', { slug, request: r.id });
  return r;
}

export function pendingRequests(slug) {
  return loadProject(slug).requests.filter((r) => r.status === 'pending');
}

export function claimRequests(slug, by = 'session') {
  const p = loadProject(slug);
  const now = new Date().toISOString();
  const claimed = [];
  const staleBefore = Date.now() - 20 * 60 * 1000; // a session that claimed and then died
  for (const r of p.requests) {
    const stale = r.status === 'claimed' && Date.parse(r.claimedAt || 0) < staleBefore;
    if (r.status === 'pending' || stale) { r.status = 'claimed'; r.claimedAt = now; r.claimedBy = by; claimed.push(r); }
  }
  if (claimed.length) save(p, 'request');
  return claimed;
}

export function resolveRequests(slug, ids, { status = 'done', reply = '', resultNodes = [] } = {}) {
  const p = loadProject(slug);
  const now = new Date().toISOString();
  const done = [];
  for (const r of p.requests) {
    if (!ids.includes(r.id)) continue;
    r.status = status; r.doneAt = now;
    if (reply) r.reply = String(reply).slice(0, 2000);
    if (resultNodes?.length) r.resultNodes = resultNodes;
    done.push(r.id);
  }
  save(p, 'request');
  return done;
}

export function retryRequest(slug, id) {
  const p = loadProject(slug);
  const r = p.requests.find((x) => x.id === id);
  if (!r) throw new Error(`request ${id} not found`);
  Object.assign(r, { status: 'pending', reply: undefined, claimedAt: undefined, claimedBy: undefined, doneAt: undefined });
  save(p, 'request');
  events.emit('request', { slug, request: r.id });
  return r;
}

export function dismissRequest(slug, id) {
  return resolveRequests(slug, [id], { status: 'dismissed' });
}

/** Resolve with pending requests as soon as the browser sends any, or [] after timeout. */
export function waitForRequests(slug, timeoutMs, signal) {
  loadProject(slug);
  const existing = claimRequests(slug);
  if (existing.length) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let timer = null;
    let debounce = null;
    const finish = () => {
      clearTimeout(timer); clearTimeout(debounce);
      events.off('request', onReq);
      signal?.removeEventListener?.('abort', finish);
      resolve(claimRequests(slug));
    };
    // small debounce so a burst of comments arrives as one batch
    const onReq = (e) => { if (e.slug === slug) { clearTimeout(debounce); debounce = setTimeout(finish, 1500); } };
    events.on('request', onReq);
    timer = setTimeout(finish, timeoutMs);
    signal?.addEventListener?.('abort', finish);
  });
}

// ---------- critiques ----------

export const CRITIQUE_DIMENSIONS = ['philosophy', 'hierarchy', 'detail', 'functionality', 'innovation'];

export function addCritique(slug, nodeId, data) {
  const p = loadProject(slug);
  getNode(p, nodeId);
  const c = { id: nextId(p, 'critique', 'c'), nodeId, createdAt: new Date().toISOString(), ...data };
  p.critiques.push(c);
  save(p, 'critique');
  return c;
}

export function treeSummary(p) {
  const kids = (id) => p.nodes.filter((n) => n.parent === id);
  const lines = [];
  const walk = (n, depth) => {
    lines.push(`${'  '.repeat(depth)}- ${n.id} "${n.label}" [${n.viewport}]${p.selected === n.id ? ' ★selected' : ''}`);
    for (const c of kids(n.id)) walk(c, depth + 1);
  };
  for (const r of kids(null)) walk(r, 0);
  return lines.join('\n');
}
