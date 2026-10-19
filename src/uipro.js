// Bridge to UI UX Pro Max's BM25 search engine (python script shipped in its repo).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { enabledSources, sourceDir } from './sources.js';

let pythonCmd = null;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 60000, maxBuffer: 16 * 1024 * 1024, cwd: opts.cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(opts.both ? `${stdout}${stderr}` : stdout)));
  });
}

/** Find a real Python 3 (skips the Windows Store "python3" alias, which prints nothing). */
export async function findPython() {
  if (pythonCmd) return pythonCmd;
  const candidates = config.python ? [[config.python]]
    : process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
  for (const c of candidates) {
    try {
      const out = await run(c[0], [...c.slice(1), '--version'], { timeout: 10000, both: true });
      if (/Python 3\./.test(out)) { pythonCmd = c; return c; }
    } catch { /* try next */ }
  }
  throw new Error('Python 3 not found. Install Python 3 or set DESIGN_HUB_PYTHON. UI UX Pro Max search needs it.');
}

export function engineScript() {
  for (const src of enabledSources()) {
    const rel = src.provides?.styleEngine;
    if (!rel) continue;
    const file = path.join(sourceDir(src.id), rel);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function runEngine(args) {
  const script = engineScript();
  if (!script) throw new Error('UI UX Pro Max engine is not installed. Run hub_update (action "apply") or `design-hub setup`.');
  const py = await findPython();
  try {
    return await run(py[0], [...py.slice(1), script, ...args], { cwd: path.dirname(script) });
  } catch (e) {
    throw new Error(`UI UX Pro Max search failed: ${(e.stderr || e.message || '').toString().trim().split('\n').slice(-4).join(' | ')}`);
  }
}

export async function styleSearch({ query, domain, stack, maxResults = 3, full = false }) {
  const args = [query, '--max-results', String(Math.min(Math.max(maxResults, 1), 20))];
  if (stack) args.push('--stack', stack);
  else if (domain) args.push('--domain', domain);
  if (full) args.push('--full');
  return runEngine(args);
}

export async function styleDesignSystem({ query, projectName, variance, motion, density }) {
  const args = [query, '--design-system', '--format', 'markdown'];
  if (projectName) args.push('--project-name', projectName);
  if (variance) args.push('--variance', String(variance));
  if (motion) args.push('--motion', String(motion));
  if (density) args.push('--density', String(density));
  return runEngine(args);
}
