#!/usr/bin/env node
// Design Hub MCP entry point (stdio). Used by the Claude Code plugin and by `claude mcp add`.
//
// Kept dependency-free on purpose: when the plugin is loaded in place (a marketplace added from a
// local folder, or --plugin-dir) Claude Code does not install node_modules, so on first start we
// install them here and then load the real server.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const say = (m) => process.stderr.write(`[design-hub] ${m}\n`);

// A background Claude Code run started by Design Hub talks to the hub over HTTP. If that run also
// loads this plugin, its copy of the server must not start a second canvas and runner.
if (process.env.DESIGN_HUB_WORKER === '1') {
  say('background run: plugin copy of the server stays idle');
  process.exit(0);
}

const required = ['@modelcontextprotocol/sdk', 'zod', 'yaml', 'playwright-core'];
const missing = required.filter((p) => !fs.existsSync(path.join(root, 'node_modules', ...p.split('/'), 'package.json')));
if (missing.length) {
  say(`installing dependencies (${missing.join(', ')}) — first start only…`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const hasLock = fs.existsSync(path.join(root, 'package-lock.json'));
  const r = spawnSync(npm, [hasLock ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: root, stdio: ['ignore', 2, 2], shell: process.platform === 'win32', timeout: 180000, windowsHide: true,
  });
  if (r.status !== 0) {
    say(`npm failed (${r.error?.message || `exit ${r.status}`}). Run "npm install" in ${root} and restart Claude Code.`);
    process.exit(1);
  }
}

await import(pathToFileURL(path.join(root, 'src', 'main.js')).href);
