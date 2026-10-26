import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-home-'));
process.env.DESIGN_HUB_HOME = home;
process.env.DESIGN_HUB_SOURCES = path.join(home, 'sources.json');
fs.writeFileSync(process.env.DESIGN_HUB_SOURCES, JSON.stringify({ sources: [
  { id: 'rich', repo: 'x', provides: { systems: ['s'] } },
  { id: 'brands', repo: 'y', dropDuplicates: true, provides: { systems: ['s'] } },
] }));
for (const [src, name] of [['rich', 'linear-app'], ['brands', 'linear.app'], ['brands', 'oura']]) {
  fs.mkdirSync(path.join(home, 'vendor', src, 's', name), { recursive: true });
  fs.writeFileSync(path.join(home, 'vendor', src, 's', name, 'DESIGN.md'), `# ${name}\n`);
}
const { config } = await import('../src/config.js');
const { catalog } = await import('../src/catalog.js');

test('a DESIGN.md with a YAML front matter gets its title and description from it', () => {
  const dir = path.join(config.overridesDir, 'systems', 'acme');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'DESIGN.md'), `---\nversion: alpha\nname: Acme-Inspired-design-analysis\ndescription: Warm cream canvas, coral CTAs.\ncolors:\n  primary: "#cc785c"\n---\n\n> **Source pages analyzed:** home\n\n## Overview\n\nBody.\n`);
  const it = catalog().items.find((i) => i.id === 'local/acme');
  assert.equal(it.title, 'Design System Inspired by Acme');
  assert.equal(it.description, 'Warm cream canvas, coral CTAs.');
});

test('a source with dropDuplicates loses the brands an earlier source already has', () => {
  const ids = catalog().items.filter((i) => i.kind === 'systems').map((i) => i.id);
  assert.ok(ids.includes('rich/linear-app') && ids.includes('brands/oura'));
  assert.ok(!ids.includes('brands/linear.app'));
});
