// Catalog of everything pulled from upstream sources + local overrides:
// design systems, rendering templates, skills, craft rules and references.
// Built by scanning the checkouts, so it follows upstream after every update.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { config } from './config.js';
import { enabledSources, sourceDir } from './sources.js';

export const KINDS = ['systems', 'templates', 'skills', 'rules', 'references'];
const SKIP_DIRS = new Set(['node_modules', '.git', '_schema', '__pycache__']);
const SKIP_MD = new Set(['README.md', 'FUTURE_SECTIONS.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE.md']);

let cache = null;

export function invalidateCatalog() { cache = null; }

function safeRead(file, limit = 400000) {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(0, limit).toString('utf8');
  } catch { return null; }
}

export function parseFrontmatter(text) {
  if (!text?.startsWith('---')) return { data: {}, body: text ?? '' };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { data: {}, body: text };
  let data = {};
  try { data = YAML.parse(text.slice(3, end)) || {}; } catch { data = {}; }
  return { data, body: text.slice(end + 4).replace(/^\s*\n/, '') };
}

function oneLine(s, max = 220) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name))
      .map((d) => d.name);
  } catch { return []; }
}

function systemItem(source, dir, name) {
  const designFile = path.join(dir, 'DESIGN.md');
  if (!fs.existsSync(designFile)) return null;
  // Google Stitch-style DESIGN.md (awesome-design-md) keeps name, description and tokens in a YAML front matter
  const { data, body } = parseFrontmatter(safeRead(designFile) || '');
  const head = body.slice(0, 4000);
  const brand = String(data.name || '').replace(/[-\s]*(inspired[-\s]*)?(design[-\s]*)?analysis$|\s+inspired$/i, '').replace(/-/g, ' ').trim();
  const title = (head.match(/^#\s+(.+)$/m)?.[1] || (brand && `Design System Inspired by ${brand}`) || name).trim();
  const category = head.match(/^>\s*Category:\s*(.+)$/m)?.[1]?.trim() || '';
  const quoteLines = [...head.matchAll(/^>\s*(.+)$/gm)].map((m) => m[1]).filter((l) => !/^Category:/i.test(l));
  const firstPara = head.replace(/^#.*$/gm, '').split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('>') && !p.startsWith('|')) || '';
  const manifest = (() => { try { return JSON.parse(safeRead(path.join(dir, 'manifest.json')) || 'null'); } catch { return null; } })();
  const languages = fs.readdirSync(dir).map((f) => f.match(/^DESIGN-([a-z-]+)\.md$/i)?.[1]).filter(Boolean);
  return {
    kind: 'systems', source, name, dir, title, category,
    description: oneLine(data.description || quoteLines[0] || manifest?.description || firstPara),
    files: ['DESIGN.md', 'tokens.css', 'tailwind-v4.css', 'design-tokens.json', 'USAGE.md', 'components.html']
      .filter((f) => fs.existsSync(path.join(dir, f))),
    languages,
    suggestedRules: manifest?.craft?.suggested || [],
  };
}

function skillItem(kind, source, dir, fallbackName) {
  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;
  const { data } = parseFrontmatter(safeRead(skillFile, 20000));
  const od = data.od || {};
  return {
    kind, source, dir,
    name: String(data.name || fallbackName),
    title: String(data.name || fallbackName),
    description: oneLine(data.description, 260),
    triggers: Array.isArray(data.triggers) ? data.triggers.map(String).slice(0, 12) : [],
    category: od.category || od.scenario || '',
    mode: od.mode || '',
    platform: od.platform || '',
    requiresDesignSystem: od.design_system?.requires ?? null,
    rules: Array.isArray(od.craft?.requires) ? od.craft.requires.map(String) : [],
    upstream: od.upstream || data.metadata?.repository || '',
    hasExample: fs.existsSync(path.join(dir, 'example.html')),
  };
}

function mdItems(kind, source, dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || SKIP_MD.has(e.name)) continue;
    const file = path.join(dir, e.name);
    const head = safeRead(file, 3000) || '';
    const { data, body } = parseFrontmatter(head);
    const title = (data.title || body.match(/^#\s+(.+)$/m)?.[1] || e.name.replace(/\.md$/, '')).toString().trim();
    const firstPara = body.replace(/^#.*$/gm, '').split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('>') && !p.startsWith('|')) || '';
    out.push({ kind, source, name: e.name.replace(/\.md$/, ''), file, title, description: oneLine(data.description || firstPara) });
  }
  return out;
}

function scanRoot(kind, source, root) {
  const items = [];
  if (!fs.existsSync(root)) return items;
  if (kind === 'rules' || kind === 'references') return mdItems(kind, source, root);
  // a root that is itself a skill (e.g. huashu-design's repo root)
  if ((kind === 'skills' || kind === 'templates') && fs.existsSync(path.join(root, 'SKILL.md'))) {
    const it = skillItem(kind, source, root, path.basename(root));
    if (it) items.push(it);
    return items;
  }
  for (const name of listDirs(root)) {
    const dir = path.join(root, name);
    const it = kind === 'systems' ? systemItem(source, dir, name) : skillItem(kind, source, dir, name);
    if (it) items.push(it);
  }
  return items;
}

function build() {
  const all = [];
  const dropDuplicates = new Set();
  // local overrides first: they win over upstream items with the same name
  for (const kind of KINDS) {
    for (const it of scanRoot(kind, 'local', path.join(config.overridesDir, kind))) all.push(it);
  }
  for (const src of enabledSources()) {
    if (src.dropDuplicates) dropDuplicates.add(src.id);
    const base = sourceDir(src.id);
    if (!fs.existsSync(base)) continue;
    for (const [kind, roots] of Object.entries(src.provides || {})) {
      if (!KINDS.includes(kind)) continue;
      for (const r of [].concat(roots)) {
        for (const it of scanRoot(kind, src.id, path.join(base, r))) all.push(it);
      }
    }
  }
  const seen = new Set();
  for (const it of all) {
    it.id = `${it.source}/${it.name}`;
    // "linear.app" and "linear-app" are the same brand
    const key = `${it.kind}:${it.name.replace(/\./g, '-')}`;
    it.shadowed = seen.has(key);
    seen.add(key);
  }
  return { builtAt: Date.now(), items: all.filter((it) => !(it.shadowed && dropDuplicates.has(it.source))) };
}

export function catalog() {
  if (!cache) cache = build();
  return cache;
}

export function stats() {
  const c = catalog();
  const out = {};
  for (const it of c.items) {
    out[it.kind] ??= {};
    out[it.kind][it.source] = (out[it.kind][it.source] || 0) + 1;
  }
  return out;
}

/** Resolve an item by id ("source/name"), by bare name (first non-shadowed match), or by kind+name. */
export function findItem(ref, kind) {
  const items = catalog().items.filter((it) => !kind || it.kind === kind);
  return items.find((it) => it.id === ref)
    || items.find((it) => it.name === ref && !it.shadowed)
    || items.find((it) => it.name.toLowerCase() === String(ref).toLowerCase())
    || null;
}

function tokens(s) {
  return String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
}

export function search(query, { kind, source, limit = 15 } = {}) {
  const q = tokens(query);
  const items = catalog().items.filter((it) => !it.shadowed && (!kind || kind === 'all' || it.kind === kind) && (!source || it.source === source));
  if (!q.length) return items.slice(0, limit);
  const scored = [];
  for (const it of items) {
    const name = tokens(it.name).join(' ');
    const hay = {
      name, title: tokens(it.title).join(' '),
      triggers: tokens((it.triggers || []).join(' ')).join(' '),
      category: tokens(it.category).join(' '),
      desc: tokens(it.description).join(' '),
    };
    let score = 0;
    for (const t of q) {
      if (hay.name.split(' ').includes(t)) score += 6; else if (hay.name.includes(t)) score += 4;
      if (hay.title.includes(t)) score += 3;
      if (hay.triggers.includes(t)) score += 3;
      if (hay.category.includes(t)) score += 2;
      if (hay.desc.includes(t)) score += 1;
    }
    if (score) scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score || a.it.name.localeCompare(b.it.name));
  return scored.slice(0, limit).map((s) => s.it);
}

export function summarize(it) {
  const base = { id: it.id, kind: it.kind, title: it.title !== it.name ? it.title : undefined, description: it.description };
  if (it.category) base.category = it.category;
  if (it.mode) base.mode = it.mode;
  if (it.rules?.length) base.rules = it.rules;
  if (it.triggers?.length) base.triggers = it.triggers.slice(0, 5);
  if (it.languages?.length) base.languages = it.languages;
  return base;
}

/** Paginate long text so a single tool result stays within MCP output limits. */
export function page(text, offset = 0, maxChars = config.maxChars) {
  const total = text.length;
  const slice = text.slice(offset, offset + maxChars);
  const next = offset + slice.length < total ? offset + slice.length : null;
  return { text: slice, total, offset, next };
}

/** List files of a skill/template folder so the agent can Read references, assets and scripts. */
export function fileTree(dir, max = 120) {
  const out = [];
  const walk = (d, rel, depth) => {
    if (out.length >= max || depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r, depth + 1);
      else if (out.length < max) out.push(r);
    }
  };
  walk(dir, '', 0);
  return out;
}

export function readItemText(it, { part, lang } = {}) {
  if (it.kind === 'rules' || it.kind === 'references') return safeRead(it.file) ?? '';
  if (it.kind === 'systems') {
    const fileMap = { design: 'DESIGN.md', tokens: 'tokens.css', tailwind: 'tailwind-v4.css', json: 'design-tokens.json', usage: 'USAGE.md', components: 'components.html' };
    let file = fileMap[part || 'design'] || 'DESIGN.md';
    if (file === 'DESIGN.md' && lang && fs.existsSync(path.join(it.dir, `DESIGN-${lang}.md`))) file = `DESIGN-${lang}.md`;
    return safeRead(path.join(it.dir, file)) ?? '';
  }
  if (part === 'example' && it.hasExample) return safeRead(path.join(it.dir, 'example.html')) ?? '';
  return safeRead(path.join(it.dir, 'SKILL.md')) ?? '';
}

/** Rules a template/skill declares in od.craft.requires, resolved against the catalog. */
export function resolveRules(names = []) {
  const found = [];
  const missing = [];
  for (const n of names) {
    const r = findItem(n, 'rules');
    if (r) found.push(r); else missing.push(n);
  }
  return { found, missing };
}
