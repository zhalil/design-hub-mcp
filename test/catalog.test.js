import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DESIGN_HUB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-home-'));
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
