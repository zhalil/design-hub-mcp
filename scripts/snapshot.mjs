// Cut the copy of every enabled source that ships inside the plugin (snapshot/), so a fresh install
// has a working catalog before anything comes from GitHub. Run before a release: `npm run snapshot`.
// Pulls the latest upstream into ~/.design-hub/vendor first, then packs each checkout (no .git) as tar + brotli.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { ensureDirs, writeJson } from '../src/config.js';
import { applyUpdates, enabledSources, readLock, sourceDir, SNAPSHOT_DIR } from '../src/sources.js';

ensureDirs();
const failed = (await applyUpdates()).filter((r) => r.error);
if (failed.length) throw new Error(`update failed: ${JSON.stringify(failed)}`);

const lock = readLock();
const manifest = {};
fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
for (const src of enabledSources()) {
  const dir = sourceDir(src.id);
  const l = lock[src.id];
  if (!l?.commit || l.snapshot) throw new Error(`${src.id}: no git checkout in ${dir}`);
  if (execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error(`${src.id}: ${dir} has local changes`);
  const tar = execFileSync('tar', ['--format=pax', '--exclude=.git', '-cf', '-', '.'], { cwd: dir, maxBuffer: 1 << 30 });
  const br = zlib.brotliCompressSync(tar, { params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: tar.length,
  } });
  fs.writeFileSync(path.join(SNAPSHOT_DIR, `${src.id}.tar.br`), br);
  manifest[src.id] = { repo: src.repo, ref: src.ref, sparse: src.sparse ?? null, commit: l.commit, commitDate: l.commitDate, subject: l.subject };
  console.log(`${src.id} @ ${l.commit.slice(0, 10)}: ${(tar.length / 1e6).toFixed(1)} MB -> ${(br.length / 1e6).toFixed(2)} MB`);
}
writeJson(path.join(SNAPSHOT_DIR, 'manifest.json'), manifest);
