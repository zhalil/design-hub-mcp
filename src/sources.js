// Upstream repositories: clone, check for updates, apply, roll back.
// Every source is a shallow, blob-less git checkout under ~/.design-hub/vendor/<id>,
// so updating is a `git fetch --depth 1` + checkout and costs little.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config, readJson, writeJson, log } from './config.js';

const LOCK_FILE = () => path.join(config.stateDir, 'sources.lock.json');
const CHECK_FILE = () => path.join(config.stateDir, 'update-check.json');
const MUTEX_FILE = () => path.join(config.stateDir, 'update.mutex');

function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: opts.timeout ?? 180000, maxBuffer: 64 * 1024 * 1024, cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim().split('\n').slice(-3).join(' | ');
          reject(new Error(`git ${args.slice(0, 3).join(' ')} failed: ${msg}`));
        } else resolve(stdout.trim());
      });
  });
}

export function loadSources() {
  const data = readJson(config.sourcesFile, null);
  if (!data || !Array.isArray(data.sources)) throw new Error(`Cannot read sources from ${config.sourcesFile}`);
  return data.sources.map((s) => ({ enabled: true, sparse: null, provides: {}, ...s }));
}

export function enabledSources() {
  return loadSources().filter((s) => s.enabled !== false);
}

export function sourceDir(id) {
  return path.join(config.vendorDir, id);
}

export function readLock() {
  return readJson(LOCK_FILE(), {});
}

function writeLock(lock) {
  writeJson(LOCK_FILE(), lock);
}

/** Simple cross-process mutex so two Claude sessions don't update at once. */
async function withMutex(fn) {
  const file = MUTEX_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let st = null;
  try { st = fs.statSync(file); } catch { /* no mutex held */ }
  if (st && Date.now() - st.mtimeMs < 10 * 60 * 1000) {
    throw new Error('Another Design Hub process is updating sources right now. Try again in a minute.');
  }
  fs.writeFileSync(file, String(process.pid));
  try { return await fn(); } finally { fs.rmSync(file, { force: true }); }
}

async function applySparse(dir, src) {
  if (Array.isArray(src.sparse) && src.sparse.length) {
    await git(['-C', dir, 'sparse-checkout', 'init', '--cone']);
    await git(['-C', dir, 'sparse-checkout', 'set', ...src.sparse]);
  } else {
    await git(['-C', dir, 'sparse-checkout', 'disable']).catch(() => {});
  }
}

async function fetchRef(dir, ref) {
  await git(['-C', dir, 'fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', ref], { timeout: 600000 });
  return git(['-C', dir, 'rev-parse', 'FETCH_HEAD']);
}

async function commitInfo(dir, rev) {
  const out = await git(['-C', dir, 'log', '-1', '--format=%H%x09%cI%x09%s', rev]).catch(() => '');
  const [commit, date, ...subject] = out.split('\t');
  return { commit, date, subject: subject.join('\t') };
}

async function cloneSource(src) {
  const dir = sourceDir(src.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await git(['init', '--quiet', dir]);
  await git(['-C', dir, 'remote', 'add', 'origin', src.repo]);
  await git(['-C', dir, 'config', 'remote.origin.promisor', 'true']);
  await git(['-C', dir, 'config', 'remote.origin.partialclonefilter', 'blob:none']);
  // deep template paths exceed Windows' 260-char limit without this
  if (process.platform === 'win32') await git(['-C', dir, 'config', 'core.longpaths', 'true']);
  await applySparse(dir, src);
  const sha = await fetchRef(dir, src.ref || 'HEAD');
  await git(['-C', dir, 'checkout', '--quiet', '--detach', sha], { timeout: 600000 });
  return sha;
}

function isCloned(id) {
  return fs.existsSync(path.join(sourceDir(id), '.git'));
}

/** Clone every enabled source that is missing. */
export async function ensureSources({ onProgress } = {}) {
  const lock = readLock();
  const done = [];
  for (const src of enabledSources()) {
    if (isCloned(src.id)) continue;
    onProgress?.(`cloning ${src.id} from ${src.repo}`);
    const sha = await cloneSource(src);
    const info = await commitInfo(sourceDir(src.id), sha);
    lock[src.id] = { ref: src.ref, commit: sha, previous: null, updatedAt: new Date().toISOString(), commitDate: info.date, subject: info.subject };
    writeLock(lock);
    done.push(src.id);
  }
  return done;
}

/** Map changed paths to catalog items (first path segment under each provided root). */
function summarizeChanges(src, nameStatus) {
  const roots = [];
  for (const [kind, val] of Object.entries(src.provides || {})) {
    for (const p of [].concat(val)) {
      if (typeof p === 'string' && !p.endsWith('.py')) roots.push({ kind, root: p === '.' ? '' : p.replace(/\/$/, '') });
    }
  }
  roots.sort((a, b) => b.root.length - a.root.length);
  const items = new Map();
  const files = { added: 0, modified: 0, deleted: 0 };
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [status, ...rest] = line.split('\t');
    const file = rest[rest.length - 1];
    const s = status[0];
    if (s === 'A') files.added++; else if (s === 'D') files.deleted++; else files.modified++;
    const hit = roots.find((r) => r.root === '' || file === r.root || file.startsWith(r.root + '/'));
    if (!hit) continue;
    const rel = hit.root ? file.slice(hit.root.length + 1) : file;
    const seg = rel.split('/')[0];
    if (!seg) continue;
    const name = seg.replace(/\.md$/, '');
    const key = `${hit.kind}:${name}`;
    const prev = items.get(key);
    // An item is "added" only if all its files are added, "removed" if all deleted
    const kindOfChange = s === 'A' ? 'added' : s === 'D' ? 'removed' : 'changed';
    if (!prev) items.set(key, { kind: hit.kind, name, change: kindOfChange });
    else if (prev.change !== kindOfChange) prev.change = 'changed';
  }
  const grouped = {};
  for (const it of items.values()) {
    grouped[it.kind] ??= { added: [], removed: [], changed: [] };
    grouped[it.kind][it.change].push(it.name);
  }
  return { files, items: grouped };
}

/** Fetch every source and report what an update would change. Does not touch checkouts. */
export async function checkUpdates({ ids } = {}) {
  await ensureSources();
  const lock = readLock();
  const results = [];
  for (const src of enabledSources()) {
    if (ids?.length && !ids.includes(src.id)) continue;
    const dir = sourceDir(src.id);
    try {
      const head = await git(['-C', dir, 'rev-parse', 'HEAD']);
      const remote = await fetchRef(dir, src.ref || 'HEAD');
      if (remote === head) {
        results.push({ id: src.id, upToDate: true, commit: head.slice(0, 10) });
        continue;
      }
      const scope = Array.isArray(src.sparse) && src.sparse.length ? src.sparse : ['.'];
      const diff = await git(['-C', dir, 'diff', '--no-renames', '--name-status', head, remote, '--', ...scope]);
      const info = await commitInfo(dir, remote);
      results.push({
        id: src.id, upToDate: false, current: head.slice(0, 10), latest: remote.slice(0, 10),
        latestDate: info.date, latestSubject: info.subject, ...summarizeChanges(src, diff),
      });
    } catch (e) {
      results.push({ id: src.id, error: e.message, commit: lock[src.id]?.commit?.slice(0, 10) });
    }
  }
  const check = { checkedAt: new Date().toISOString(), results };
  writeJson(CHECK_FILE(), check);
  return check;
}

export function lastCheck() {
  return readJson(CHECK_FILE(), null);
}

/** Move sources to the latest commit of their ref. Returns per-source results. */
export async function applyUpdates({ ids } = {}) {
  return withMutex(async () => {
    await ensureSources();
    const lock = readLock();
    const results = [];
    for (const src of enabledSources()) {
      if (ids?.length && !ids.includes(src.id)) continue;
      const dir = sourceDir(src.id);
      try {
        const head = await git(['-C', dir, 'rev-parse', 'HEAD']);
        await applySparse(dir, src);
        const remote = await fetchRef(dir, src.ref || 'HEAD');
        if (remote === head) { results.push({ id: src.id, upToDate: true }); continue; }
        await git(['-C', dir, 'checkout', '--quiet', '--force', '--detach', remote], { timeout: 600000 });
        const info = await commitInfo(dir, remote);
        lock[src.id] = { ref: src.ref, commit: remote, previous: head, updatedAt: new Date().toISOString(), commitDate: info.date, subject: info.subject };
        writeLock(lock);
        results.push({ id: src.id, updated: true, from: head.slice(0, 10), to: remote.slice(0, 10), subject: info.subject });
      } catch (e) {
        results.push({ id: src.id, error: e.message });
      }
    }
    // the stored check is stale after an apply
    fs.rmSync(CHECK_FILE(), { force: true });
    return results;
  });
}

/** Return a source to the commit it had before the last update. */
export async function rollback({ ids } = {}) {
  return withMutex(async () => {
    const lock = readLock();
    const results = [];
    for (const src of enabledSources()) {
      if (ids?.length && !ids.includes(src.id)) continue;
      const entry = lock[src.id];
      if (!entry?.previous) { results.push({ id: src.id, skipped: 'no previous commit recorded' }); continue; }
      const dir = sourceDir(src.id);
      try {
        await git(['-C', dir, 'cat-file', '-e', `${entry.previous}^{commit}`]).catch(() => fetchRef(dir, entry.previous));
        await git(['-C', dir, 'checkout', '--quiet', '--force', '--detach', entry.previous], { timeout: 600000 });
        const info = await commitInfo(dir, entry.previous);
        lock[src.id] = { ...entry, commit: entry.previous, previous: entry.commit, updatedAt: new Date().toISOString(), commitDate: info.date, subject: info.subject, rolledBack: true };
        writeLock(lock);
        results.push({ id: src.id, rolledBackTo: entry.previous.slice(0, 10) });
      } catch (e) {
        results.push({ id: src.id, error: e.message });
      }
    }
    return results;
  });
}

export function sourcesStatus() {
  const lock = readLock();
  const check = lastCheck();
  return loadSources().map((s) => {
    const l = lock[s.id];
    const c = check?.results?.find((r) => r.id === s.id);
    return {
      id: s.id, repo: s.repo, ref: s.ref, enabled: s.enabled !== false, cloned: isCloned(s.id), license: s.license,
      commit: l?.commit?.slice(0, 10) ?? null, commitDate: l?.commitDate ?? null, updatedAt: l?.updatedAt ?? null,
      canRollback: Boolean(l?.previous),
      updateAvailable: c ? (c.upToDate === false) : null,
    };
  });
}

/** Background check (and optional apply) at most once per `updateCheckDays`. */
export async function maybeBackgroundCheck(onApplied) {
  if (!config.updateCheckDays) return;
  const prev = lastCheck();
  if (prev && Date.now() - Date.parse(prev.checkedAt) < config.updateCheckDays * 864e5) return;
  try {
    const check = await checkUpdates();
    const pending = check.results.filter((r) => r.upToDate === false).map((r) => r.id);
    log(`update check: ${pending.length ? 'updates for ' + pending.join(', ') : 'all sources up to date'}`);
    if (pending.length && config.autoUpdate) {
      const res = await applyUpdates({ ids: pending });
      log(`auto-update applied: ${JSON.stringify(res)}`);
      await onApplied?.(res);
    }
  } catch (e) {
    log(`background update check failed: ${e.message}`);
  }
}
