import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Plugin options arrive as env values like "${user_config.port}". If Claude Code left one
// unsubstituted, or the user left it empty, drop it so the built-in default applies.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('DESIGN_HUB_') && (process.env[k] === '' || process.env[k].includes('${'))) delete process.env[k];
}

function envInt(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

/** Where upstream clones, user overrides and hub state live (shared by all projects). */
export const HUB_HOME = path.resolve(process.env.DESIGN_HUB_HOME || path.join(os.homedir(), '.design-hub'));

/** Where design projects of the current repo live. Claude Code starts MCP servers in the project dir. */
function defaultWorkspace() {
  // the plugin passes ${CLAUDE_PROJECT_DIR}; a plain `claude mcp add` server runs in the project dir
  const cwd = process.env.DESIGN_HUB_PROJECT_DIR || process.cwd();
  if (path.resolve(cwd) === path.resolve(os.homedir())) return path.join(HUB_HOME, 'workspace');
  return path.join(cwd, '.design-hub');
}

export const config = {
  hubHome: HUB_HOME,
  vendorDir: path.join(HUB_HOME, 'vendor'),
  overridesDir: path.join(HUB_HOME, 'overrides'),
  stateDir: path.join(HUB_HOME, 'state'),
  workspace: path.resolve(process.env.DESIGN_HUB_WORKSPACE || defaultWorkspace()),
  sourcesFile: process.env.DESIGN_HUB_SOURCES || (fs.existsSync(path.join(HUB_HOME, 'sources.json'))
    ? path.join(HUB_HOME, 'sources.json')
    : path.join(PKG_DIR, 'sources.json')),
  host: process.env.DESIGN_HUB_HOST || '127.0.0.1',
  port: envInt('DESIGN_HUB_PORT', 7777),
  /** ready = open the browser when a design is marked ready; always = also on first write; never */
  openMode: (process.env.DESIGN_HUB_OPEN || 'ready').toLowerCase(),
  /** days between background update checks (0 disables) */
  updateCheckDays: envInt('DESIGN_HUB_UPDATE_CHECK_DAYS', 1),
  /** apply updates automatically after a background check (on unless set to 0) */
  autoUpdate: !/^(0|false|no)$/i.test(process.env.DESIGN_HUB_AUTO_UPDATE || ''),
  python: process.env.DESIGN_HUB_PYTHON || null,
  maxChars: envInt('DESIGN_HUB_MAX_CHARS', 18000),
};

export function ensureDirs() {
  for (const d of [config.hubHome, config.vendorDir, config.overridesDir, config.stateDir, config.workspace]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const k of ['systems', 'templates', 'skills', 'rules', 'references']) {
    fs.mkdirSync(path.join(config.overridesDir, k), { recursive: true });
  }
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function log(...args) {
  // stdout belongs to the MCP protocol; diagnostics go to stderr
  process.stderr.write(`[design-hub] ${args.join(' ')}\n`);
}
