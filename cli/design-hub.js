#!/usr/bin/env node
// Design Hub CLI: setup, updates from parent repositories, skills sync, standalone preview.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { config, ensureDirs, PKG_DIR } from '../src/config.js';
import * as sources from '../src/sources.js';
import * as cat from '../src/catalog.js';
import * as skills from '../src/skills.js';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = {}; const args = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true); }
  else args.push(a);
}
const ids = flags.source ? String(flags.source).split(',') : undefined;
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const serverPath = path.join(PKG_DIR, 'src', 'server.js');

function printChanges(check) {
  for (const r of check.results) {
    if (r.error) { console.log(`✗ ${r.id}: ${r.error}`); continue; }
    if (r.upToDate) { console.log(`✓ ${r.id} up to date (${r.commit})`); continue; }
    console.log(`↑ ${r.id}: ${r.current} → ${r.latest} (${r.latestDate?.slice(0, 10)}) ${r.latestSubject || ''}`);
    console.log(`    files: +${r.files.added} ~${r.files.modified} -${r.files.deleted}`);
    for (const [kind, ch] of Object.entries(r.items || {})) {
      const parts = [];
      if (ch.added.length) parts.push(`new: ${ch.added.slice(0, 12).join(', ')}${ch.added.length > 12 ? ` (+${ch.added.length - 12})` : ''}`);
      if (ch.removed.length) parts.push(`removed: ${ch.removed.join(', ')}`);
      if (ch.changed.length) parts.push(`changed: ${ch.changed.length}`);
      if (parts.length) console.log(`    ${kind}: ${parts.join(' · ')}`);
    }
  }
}

async function main() {
  ensureDirs();
  switch (cmd) {
    case 'setup': {
      console.log(`Hub home: ${config.hubHome}`);
      await sources.ensureSources({ onProgress: (m) => console.log(`  ${m}`) });
      cat.invalidateCatalog();
      out({ sources: sources.sourcesStatus().map((s) => `${s.id} @ ${s.commit ?? '—'}${s.enabled ? '' : ' (disabled)'}`), catalog: cat.stats() });
      if (flags.browser) {
        // playwright-core is a dev dependency only; fetch the pinned version just to download the headless shell
        const pw = createRequire(import.meta.url)('../package.json').devDependencies['playwright-core'];
        console.log('Installing headless Chromium for screenshots/lint…');
        const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', `playwright-core@${pw}`, 'install', '--only-shell', 'chromium'], { stdio: 'inherit', shell: process.platform === 'win32' });
        if (r.status !== 0) console.log('Headless Chromium download failed. Install Google Chrome or Microsoft Edge instead, or set DESIGN_HUB_CHROME to a Chrome/Chromium executable.');
      } else {
        console.log('\nScreenshots/lint use your installed Chrome or Edge. No Chrome? run: design-hub setup --browser');
      }
      console.log(`\nRegister in Claude Code:\n  claude mcp add design-hub -s user -- node "${serverPath}"`);
      break;
    }
    case 'check': printChanges(await sources.checkUpdates({ ids })); break;
    case 'update': {
      const check = await sources.checkUpdates({ ids });
      printChanges(check);
      const pending = check.results.filter((r) => r.upToDate === false).map((r) => r.id);
      if (!pending.length || flags.check) break;
      const res = await sources.applyUpdates({ ids: pending });
      out(res);
      cat.invalidateCatalog();
      const resync = skills.resyncInstalled();
      if (resync.length) out({ installedSkills: resync });
      break;
    }
    case 'rollback': out(await sources.rollback({ ids })); cat.invalidateCatalog(); skills.resyncInstalled(); break;
    case 'status': out({ hubHome: config.hubHome, workspace: config.workspace, sources: sources.sourcesStatus(), catalog: cat.stats(), installedSkills: skills.listInstalled() }); break;
    case 'search': {
      await sources.ensureSources();
      for (const it of cat.search(args.join(' '), { kind: flags.kind || 'all', limit: Number(flags.limit) || 20 })) console.log(`${it.kind.padEnd(10)} ${it.id.padEnd(48)} ${it.description.slice(0, 90)}`);
      break;
    }
    case 'skills': {
      const [sub, ...names] = args;
      if (sub === 'install') out(skills.installSkills(names, { scope: flags.scope || 'user', mode: flags.mode || 'link' }));
      else if (sub === 'remove') out(skills.uninstallSkills(names));
      else out(skills.listInstalled());
      break;
    }
    case 'serve':
    case 'preview': {
      // canvas + MCP over HTTP + background Claude Code runs, without an interactive session
      const { startPreview, setMcpFactory } = await import('../src/preview/http.js');
      const { buildServer, startHub } = await import('../src/tools.js');
      startHub();
      setMcpFactory(() => buildServer({ worker: true }));
      const info = await startPreview();
      console.log(`Design Hub canvas: ${info.url}  (workspace ${info.workspace}) — Ctrl+C to stop`);
      if (flags.open) (await import('../src/open.js')).openBrowser(info.url);
      return; // keep running
    }
    case 'register': {
      const scope = flags.scope || 'user';
      const win = process.platform === 'win32'; // claude is a .cmd shim there, so it needs a shell — and quoting
      const q = (s) => (win ? `"${s}"` : s);
      const r = spawnSync('claude', ['mcp', 'add', 'design-hub', '-s', scope, '--', q(process.execPath), q(serverPath)], { stdio: 'inherit', shell: win });
      if (r.status !== 0) console.log(`\nCould not run the claude CLI. Run this yourself:\n  claude mcp add design-hub -s ${scope} -- node "${serverPath}"`);
      break;
    }
    default:
      console.log(`design-hub — OpenDesign + huashu-design + UI UX Pro Max behind one MCP server

  setup [--browser]            clone parent repositories (and optionally headless Chromium)
  check [--source id,…]        show what changed upstream (new/removed systems, templates, skills, rules)
  update [--source id,…]       pull the latest skills/rules/systems; installed skills re-sync
  rollback [--source id,…]     go back to the commit before the last update
  status                       sources, commits, catalog counts, installed skills
  search <query> [--kind k]    search systems/templates/skills/rules/references
  skills install <id…> [--scope user|project] [--mode link|copy]
  skills remove <id…> | skills list
  serve [--open]               run the canvas on its own (requests are handled by background Claude Code)
  register [--scope user]      add the MCP server to Claude Code

Data: ${config.hubHome}   Sources: ${config.sourcesFile}`);
  }
}

main().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
