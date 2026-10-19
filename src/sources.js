// Upstream repositories: clone, check for updates, apply, roll back.
// Every source is a shallow, blob-less git checkout under ~/.design-hub/vendor/<id>,
// so updating is a `git fetch --depth 1` + checkout and costs little. A fresh install starts
// from the copy bundled in snapshot/ and swaps in a git checkout once upstream has moved on.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile, spawnSync } from 'node:child_process';
import { config, readJson, writeJson, log, PKG_DIR } from './config.js';

const LOCK_FILE = () => path.join(config.stateDir, 'sources.lock.json');
const CHECK_FILE = () => path.join(config.stateDir, 'update-check.json');
const MUTEX_FILE = () => path.join(config.stateDir, 'update.mutex');
export const SNAPSHOT_DIR = path.join(PKG_DIR, 'snapshot');

// Abort a transfer that stalls below 1 KB/s for a minute instead of hanging until a timeout.
const GIT_NET = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60'];

function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT_NET, ...args], { timeout: opts.timeout ?? 180000, maxBuffer: 64 * 1024 * 1024, cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim().split('\n').slice(-3).join(' | ');
          reject(new Error(`git ${args.slice(0, 4).join(' ')} failed: ${msg}`));
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

/** Retry flaky network steps: blobs fetched by a finished attempt stay in the repo. */
async function retry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries) throw e;
      log(`${e.message} — retry ${i}/${tries - 1}`);
    }
  }
}

// Pictures, sound, video, fonts and archives feed neither the catalog nor the skills' text: never check them out.
const MEDIA = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'psd', 'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'mov', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'zip', 'gz', 'tgz', 'pdf'].flatMap((e) => [`!*.${e}`, `!*.${e.toUpperCase()}`]);

// `sparse` entries are directories ("skills") or gitignore-style patterns ("/x/*/DESIGN.md", "!/demos/").
// Returns the include patterns and the exclude patterns (always ending with MEDIA).
function sparseSpec(src) {
  const list = Array.isArray(src.sparse) && src.sparse.length ? src.sparse : ['/*'];
  const include = list.filter((p) => !p.startsWith('!')).map((p) => (/^\/|[*?]/.test(p) ? p : `/${p.replace(/\/$/, '')}/`));
  return { include, exclude: [...list.filter((p) => p.startsWith('!')), ...MEDIA] };
}

async function applySparse(dir, patterns) {
  await git(['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...patterns], { timeout: 0 });
}

const samePatterns = async (dir, patterns) =>
  (await git(['-C', dir, 'sparse-checkout', 'list']).catch(() => '')) === patterns.join('\n');

// Only the current snapshot is kept: drop older commits and half-downloaded packs left by dropped connections.
async function compact(dir) {
  await git(['-C', dir, 'reflog', 'expire', '--expire=now', '--all']);
  await git(['-C', dir, 'gc', '--prune=now', '--quiet'], { timeout: 0 });
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
  // Download next to the current copy (bundled snapshot or nothing) and swap only a complete checkout in.
  const dir = `${sourceDir(src.id)}.new`;
  // an interrupted clone of the same repo keeps the blobs it already has
  const url = await git(['-C', dir, 'config', 'remote.origin.url']).catch(() => null);
  if (url !== src.repo) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await git(['init', '--quiet', dir]);
    await git(['-C', dir, 'remote', 'add', 'origin', src.repo]);
    await git(['-C', dir, 'config', 'remote.origin.promisor', 'true']);
    await git(['-C', dir, 'config', 'remote.origin.partialclonefilter', 'blob:none']);
    // deep template paths exceed Windows' 260-char limit without this
    if (process.platform === 'win32') await git(['-C', dir, 'config', 'core.longpaths', 'true']);
  }
  const sha = await retry(() => fetchRef(dir, src.ref || 'HEAD'));
  // Check out one include pattern at a time so a dropped connection costs one directory, not the whole repo.
  const { include, exclude } = sparseSpec(src);
  await applySparse(dir, [include[0], ...exclude]);
  await retry(() => git(['-C', dir, 'checkout', '--quiet', '--force', '--detach', sha], { timeout: 0 }));
  for (let i = 2; i <= include.length; i++) {
    await retry(() => applySparse(dir, [...include.slice(0, i), ...exclude]));
  }
  await compact(dir);
  const final = sourceDir(src.id);
  const old = `${final}.old`;
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(final)) fs.renameSync(final, old);
  try { fs.renameSync(dir, final); } catch (e) { if (fs.existsSync(old)) fs.renameSync(old, final); throw e; }
  fs.rmSync(old, { recursive: true, force: true });
  return sha;
}

/** Commit the source's ref points to upstream, without downloading anything. */
async function remoteCommit(src) {
  const ref = src.ref || 'HEAD';
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref;
  const lines = (await git(['ls-remote', src.repo, ref, `${ref}^{}`])).split('\n').filter(Boolean);
  // an annotated tag lists the tag object and then the commit it points to (^{})
  const line = lines.find((l) => l.endsWith('^{}')) || lines[0];
  if (!line) throw new Error(`ref ${ref} not found in ${src.repo}`);
  return line.split('\t')[0];
}

/**
 * First run: unpack the copy bundled with the plugin (snapshot/<id>.tar.br), so the catalog works at once
 * without GitHub. Synchronous on purpose — it takes about a second and the catalog must not be read empty.
 */
export function seedSnapshots() {
  const manifest = readJson(path.join(SNAPSHOT_DIR, 'manifest.json'), {});
  const lock = readLock();
  for (const src of enabledSources()) {
    const snap = manifest[src.id];
    const file = path.join(SNAPSHOT_DIR, `${src.id}.tar.br`);
    // only a copy cut from the same repo, ref and filter as sources.json asks for
    if (lock[src.id] || !snap || snap.repo !== src.repo || snap.ref !== src.ref
      || JSON.stringify(snap.sparse) !== JSON.stringify(src.sparse) || !fs.existsSync(file)) continue;
    const dir = sourceDir(src.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // cwd instead of -C: GNU tar (Git Bash) reads a "C:" path as a remote host
    const r = spawnSync('tar', ['-xf', '-'], { cwd: dir, input: zlib.brotliDecompressSync(fs.readFileSync(file)) });
    if (r.status !== 0) {
      log(`unpacking the bundled ${src.id} failed: ${r.error?.message || String(r.stderr).trim()}`);
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    lock[src.id] = { ref: src.ref, commit: snap.commit, previous: null, updatedAt: new Date().toISOString(), commitDate: snap.commitDate, subject: snap.subject, snapshot: true };
    writeLock(lock);
  }
}

// The lock entry is written only after a complete checkout, so an interrupted clone is retried.
function isCloned(id) {
  return fs.existsSync(path.join(sourceDir(id), '.git')) && Boolean(readLock()[id]?.commit);
}

let ensuring = null;

/** Clone every enabled source that is missing. One failing source does not stop the others. */
export function ensureSources(opts) {
  // startup and hub_update can both ask at once; never clone the same source twice in parallel
  ensuring ??= cloneMissing(opts).finally(() => { ensuring = null; });
  return ensuring;
}

async function cloneMissing({ onProgress, onCloned } = {}) {
  seedSnapshots();
  const done = [];
  const errors = [];
  for (const src of enabledSources()) {
    if (isCloned(src.id)) {
      // sources.json changed what to keep: re-filter the existing checkout (drops files locally, fetches only new ones)
      const { include, exclude } = sparseSpec(src);
      const patterns = [...include, ...exclude];
      if (!(await samePatterns(sourceDir(src.id), patterns))) {
        try { await applySparse(sourceDir(src.id), patterns); await compact(sourceDir(src.id)); } catch (e) { errors.push(`${src.id}: ${e.message}`); }
      }
      continue;
    }
    const snap = readLock()[src.id];
    if (snap?.snapshot) {
      // the bundled copy stays until upstream moves on; then the newer version is downloaded in the background
      try {
        if (await remoteCommit(src) === snap.commit) continue;
      } catch (e) { errors.push(`${src.id}: ${e.message}`); continue; }
    }
    onProgress?.(`cloning ${src.id} from ${src.repo}`);
    try {
      const sha = await cloneSource(src);
      const info = await commitInfo(sourceDir(src.id), sha);
      const lock = readLock();
      lock[src.id] = { ref: src.ref, commit: sha, previous: null, updatedAt: new Date().toISOString(), commitDate: info.date, subject: info.subject };
      writeLock(lock);
      done.push(src.id);
      onCloned?.(src.id);
    } catch (e) {
      errors.push(`${src.id}: ${e.message}`);
      onProgress?.(`cloning ${src.id} failed: ${e.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
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
    // ensureSources() already compared a bundled copy with upstream and replaced it if it was behind
    if (lock[src.id]?.snapshot) { results.push({ id: src.id, upToDate: true, commit: lock[src.id].commit.slice(0, 10) }); continue; }
    const dir = sourceDir(src.id);
    try {
      const head = await git(['-C', dir, 'rev-parse', 'HEAD']);
      const remote = await fetchRef(dir, src.ref || 'HEAD');
      if (remote === head) {
        results.push({ id: src.id, upToDate: true, commit: head.slice(0, 10) });
        continue;
      }
      const scope = sparseSpec(src).include.map((p) => (p === '/*' ? '.' : `:(glob)${p.replace(/^\//, '').replace(/\/$/, '/**')}`));
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
      if (lock[src.id]?.snapshot) { results.push({ id: src.id, upToDate: true }); continue; }
      const dir = sourceDir(src.id);
      try {
        const head = await git(['-C', dir, 'rev-parse', 'HEAD']);
        const { include, exclude } = sparseSpec(src);
        await applySparse(dir, [...include, ...exclude]);
        const remote = await retry(() => fetchRef(dir, src.ref || 'HEAD'));
        if (remote === head) { results.push({ id: src.id, upToDate: true }); continue; }
        await retry(() => git(['-C', dir, 'checkout', '--quiet', '--force', '--detach', remote], { timeout: 0 }));
        await compact(dir);
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
        await retry(() => git(['-C', dir, 'checkout', '--quiet', '--force', '--detach', entry.previous], { timeout: 0 }));
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
      snapshot: Boolean(l?.snapshot), commit: l?.commit?.slice(0, 10) ?? null, commitDate: l?.commitDate ?? null, updatedAt: l?.updatedAt ?? null,
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
