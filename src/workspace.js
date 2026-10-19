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
  p.nodes ??= []; p.requests ??= []; p.critiques ??= []; p.edges ??= []; p.notes ??= []; p.trash ??= [];
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
  const p = { slug: s, name: name || s, brief, status: 'draft', createdAt: now, updatedAt: now, designSystem: null, nodes: [], requests: [], critiques: [], edges: [], notes: [], trash: [], seq: { node: 0, request: 0, critique: 0, edge: 0, note: 0 } };
  p.notes.push(newNote(p, { text: `Design Context\n\n${brief || 'Describe the product: who uses it, main flows, business rules.'}\n\nTokens and styles: DESIGN.md`, pinned: true, pos: { x: -420, y: 0 }, size: { w: 360, h: 280 } }));
  return save(p, 'created');
}

function nextId(p, kind, prefix) {
  p.seq ??= { node: 0, request: 0, critique: 0, edge: 0, note: 0 };
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
export function writeNode(slug, { html, parent = null, node = null, label, note, viewport, origin = 'agent', requestId = null, linkFrom = null, linkLabel = '' }) {
  const p = loadProject(slug);
  if (linkFrom) getNode(p, linkFrom);
  if (linkFrom && linkFrom === node) throw new Error('An edge cannot link a node to itself.');
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
  if (linkFrom && !p.edges.some((e) => e.from === linkFrom && e.to === n.id)) p.edges.push({ id: nextId(p, 'edge', 'e'), from: linkFrom, to: n.id, label: String(linkLabel || ''), kind: 'nav' });
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
  const children = p.nodes.filter((c) => c.parent === id).map((c) => c.id);
  // re-parent children to the deleted node's parent
  for (const c of p.nodes) if (c.parent === id) c.parent = n.parent;
  p.nodes = p.nodes.filter((x) => x.id !== id);
  const edges = p.edges.filter((e) => e.from === id || e.to === id);
  p.edges = p.edges.filter((e) => !edges.includes(e));
  const wasSelected = p.selected === id;
  if (wasSelected) p.selected = null;
  const trash = path.join(projectDir(slug), '.trash');
  fs.mkdirSync(trash, { recursive: true });
  const trashFile = `${n.id}-${Date.now()}.html`;
  try { fs.renameSync(nodeFile(slug, n), path.join(trash, trashFile)); } catch { /* already gone */ }
  p.trash.push({ node: n, children, edges, wasSelected, trashFile, deletedAt: new Date().toISOString() });
  return save(p, 'node-deleted');
}

export function restoreNode(slug, id) {
  const p = loadProject(slug);
  const i = p.trash.findLastIndex((t) => t.node.id === id);
  if (i < 0) throw new Error(`Node "${id}" is not in the trash of project ${slug}.`);
  const [t] = p.trash.splice(i, 1);
  const from = path.join(projectDir(slug), '.trash', t.trashFile);
  fs.mkdirSync(path.dirname(nodeFile(slug, t.node)), { recursive: true });
  try { fs.renameSync(from, nodeFile(slug, t.node)); } catch { /* file already gone */ }
  p.nodes.push(t.node);
  for (const c of p.nodes) if (t.children.includes(c.id)) c.parent = id;
  const has = (x) => p.nodes.some((n) => n.id === x);
  p.edges.push(...t.edges.filter((e) => has(e.from) && has(e.to)));
  if (t.wasSelected) p.selected = id;
  save(p, 'node-restored');
  return t.node;
}

export function updateNodeMeta(slug, id, patch) {
  const p = loadProject(slug);
  const n = getNode(p, id);
  if (patch.viewport !== undefined && !VIEWPORTS[patch.viewport]) throw new Error(`viewport must be one of ${Object.keys(VIEWPORTS).join(', ')}`);
  for (const k of ['label', 'viewport', 'note']) if (patch[k] !== undefined) n[k] = patch[k];
  if (patch.x === null && patch.y === null) delete n.pos;
  else if (patch.x !== undefined && patch.y !== undefined) n.pos = { x: patch.x, y: patch.y };
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

export const REQUEST_TYPES = ['iterate', 'element', 'variations', 'comment', 'pick', 'next-page'];

export function addRequest(slug, { type, nodeId = null, text = '', element = null, count = null, viewport = null, label = '' }) {
  if (!REQUEST_TYPES.includes(type)) throw new Error(`bad request type ${type}`);
  const p = loadProject(slug);
  if (nodeId) getNode(p, nodeId);
  const r = { id: nextId(p, 'request', 'r'), type, nodeId, text: String(text || '').slice(0, 4000), element, count, viewport, label: String(label || '').slice(0, 200), status: 'pending', createdAt: new Date().toISOString() };
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

// ---------- nav edges ----------

function getEdge(p, id) {
  const e = p.edges.find((x) => x.id === id);
  if (!e) throw new Error(`Edge "${id}" not found in project ${p.slug}.`);
  return e;
}

export function addEdge(slug, { from, to, label = '' }) {
  const p = loadProject(slug);
  getNode(p, from); getNode(p, to);
  if (from === to) throw new Error('An edge cannot link a node to itself.');
  if (p.edges.some((e) => e.from === from && e.to === to)) throw new Error(`Edge ${from} -> ${to} already exists.`);
  const e = { id: nextId(p, 'edge', 'e'), from, to, label: String(label || '').slice(0, 120), kind: 'nav' };
  p.edges.push(e);
  save(p, 'edge');
  return e;
}

export function updateEdge(slug, id, { label }) {
  const p = loadProject(slug);
  const e = getEdge(p, id);
  if (label !== undefined) e.label = String(label).slice(0, 120);
  save(p, 'edge');
  return e;
}

export function deleteEdge(slug, id) {
  const p = loadProject(slug);
  const e = getEdge(p, id);
  p.edges = p.edges.filter((x) => x !== e);
  save(p, 'edge');
  return e;
}

// ---------- notes (sticky notes on the canvas; pinned ones are design context) ----------

export const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink', 'gray'];

function newNote(p, { text = '', pinned = false, color = 'yellow', pos = null, size = null }) {
  if (!NOTE_COLORS.includes(color)) throw new Error(`color must be one of ${NOTE_COLORS.join(', ')}`);
  const now = new Date().toISOString();
  return { id: nextId(p, 'note', 't'), text: String(text), pinned: !!pinned, color, pos, size, createdAt: now, updatedAt: now };
}

function getNote(p, id) {
  const n = p.notes.find((x) => x.id === id);
  if (!n) throw new Error(`Note "${id}" not found in project ${p.slug}.`);
  return n;
}

export function addNote(slug, fields = {}) {
  const p = loadProject(slug);
  const n = newNote(p, fields);
  p.notes.push(n);
  save(p, 'note');
  return n;
}

export function updateNote(slug, id, patch) {
  const p = loadProject(slug);
  const n = getNote(p, id);
  if (patch.color !== undefined && !NOTE_COLORS.includes(patch.color)) throw new Error(`color must be one of ${NOTE_COLORS.join(', ')}`);
  for (const k of ['color', 'pos', 'size']) if (patch[k] !== undefined) n[k] = patch[k];
  if (patch.text !== undefined) n.text = String(patch.text);
  if (patch.pinned !== undefined) n.pinned = !!patch.pinned;
  n.updatedAt = new Date().toISOString();
  save(p, 'note');
  return n;
}

export function deleteNote(slug, id) {
  const p = loadProject(slug);
  const n = getNote(p, id);
  p.notes = p.notes.filter((x) => x !== n);
  save(p, 'note');
  return n;
}

export const pinnedContext = (p) => p.notes.filter((n) => n.pinned).map(({ id, text }) => ({ id, text }));

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
