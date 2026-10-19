import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DESIGN_HUB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-home-'));
const { ensureDirs } = await import('../src/config.js');
const { seedSnapshots, readLock, sourceDir } = await import('../src/sources.js');

test('a fresh install unpacks the bundled snapshot without touching the network', () => {
  ensureDirs();
  seedSnapshots();
  const lock = readLock();
  assert.equal(lock['huashu-design'].snapshot, true);
  assert.match(lock['huashu-design'].commit, /^[0-9a-f]{40}$/);
  assert.ok(fs.existsSync(path.join(sourceDir('huashu-design'), 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(sourceDir('open-design'), 'LICENSE')));
  // an existing lock entry means the source is already there: never unpacked twice
  fs.rmSync(path.join(sourceDir('huashu-design'), 'SKILL.md'));
  seedSnapshots();
  assert.ok(!fs.existsSync(path.join(sourceDir('huashu-design'), 'SKILL.md')));
});
