// Install upstream skills as native Claude Code skills (~/.claude/skills or <project>/.claude/skills)
// and keep them in sync after source updates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, readJson, writeJson } from './config.js';
import { findItem, invalidateCatalog } from './catalog.js';

const STATE = () => path.join(config.stateDir, 'installed-skills.json');
const MARKER = '.design-hub.json';

export function skillsRoot(scope, projectRoot = process.cwd()) {
  return scope === 'project' ? path.join(projectRoot, '.claude', 'skills') : path.join(os.homedir(), '.claude', 'skills');
}

function installed() { return readJson(STATE(), []); }
function saveInstalled(list) { writeJson(STATE(), list); }

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/** A craft rule (plain markdown) becomes a small generated skill so Claude Code loads it on design work. */
function writeRuleSkill(item, target) {
  fs.mkdirSync(target, { recursive: true });
  const body = fs.readFileSync(item.file, 'utf8');
  const desc = `Design rule "${item.title}" (from ${item.source}). Apply when designing or reviewing UI, web pages, slides or prototypes. ${item.description}`.replace(/\s+/g, ' ').slice(0, 900);
  fs.writeFileSync(path.join(target, 'SKILL.md'), `---\nname: design-rule-${item.name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body}`);
  fs.writeFileSync(path.join(target, MARKER), JSON.stringify({ id: item.id, source: item.source, generated: true, copiedAt: new Date().toISOString() }, null, 2));
}

function placeSkill(item, target, mode) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (item.kind === 'rules') { writeRuleSkill(item, target); return 'generated'; }
  let used = mode;
  if (mode === 'link') {
    try { fs.symlinkSync(item.dir, target, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { used = 'copy'; }
  }
  if (used === 'copy') {
    copyDir(item.dir, target);
    fs.writeFileSync(path.join(target, MARKER), JSON.stringify({ id: item.id, source: item.source, copiedAt: new Date().toISOString() }, null, 2));
  }
  return used;
}

export function installSkills(ids, { scope = 'user', mode = 'link', projectRoot } = {}) {
  const root = skillsRoot(scope, projectRoot);
  const list = installed();
  const results = [];
  for (const id of ids) {
    const item = findItem(id, 'skills') || findItem(id, 'templates') || findItem(id, 'rules');
    if (!item) { results.push({ id, error: 'not found in catalog (see catalog_search kind=skills or kind=rules)' }); continue; }
    const dirName = item.kind === 'rules' ? `design-rule-${item.name}` : item.name;
    const target = path.join(root, dirName);
    // never clobber a skill the user created by hand
    if (fs.existsSync(target) && !list.some((x) => x.target === target)) {
      let isOurs = false;
      try { isOurs = fs.lstatSync(target).isSymbolicLink() || fs.existsSync(path.join(target, MARKER)); } catch { /* ignore */ }
      if (!isOurs) { results.push({ id: item.id, error: `${target} already exists and was not installed by Design Hub` }); continue; }
    }
    const used = placeSkill(item, target, mode);
    const entry = { id: item.id, kind: item.kind, target, scope, mode: used, installedAt: new Date().toISOString() };
    const idx = list.findIndex((x) => x.target === target);
    if (idx >= 0) list[idx] = entry; else list.push(entry);
    results.push({ id: item.id, target, mode: used });
  }
  saveInstalled(list);
  return results;
}

export function uninstallSkills(ids) {
  const list = installed();
  const results = [];
  const keep = [];
  for (const e of list) {
    if (ids.includes(e.id) || ids.includes(e.id.split('/').pop())) {
      fs.rmSync(e.target, { recursive: true, force: true });
      results.push({ id: e.id, removed: e.target });
    } else keep.push(e);
  }
  saveInstalled(keep);
  return results;
}

/** After an update: symlinks follow automatically; copies are refreshed; vanished skills are reported. */
export function resyncInstalled() {
  invalidateCatalog();
  const list = installed();
  const results = [];
  for (const e of list) {
    const item = findItem(e.id);
    if (!item) { results.push({ id: e.id, warning: 'no longer exists upstream; left in place' }); continue; }
    if (e.mode === 'copy' || e.mode === 'generated') { placeSkill(item, e.target, 'copy'); results.push({ id: e.id, refreshed: true }); }
    else if (!fs.existsSync(e.target)) { placeSkill(item, e.target, 'link'); results.push({ id: e.id, relinked: true }); }
  }
  return results;
}

export function listInstalled() { return installed(); }
