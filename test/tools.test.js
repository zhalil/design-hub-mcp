import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DESIGN_HUB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-home-'));
process.env.DESIGN_HUB_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-ws-'));
process.env.DESIGN_HUB_RUNNER = 'false';
const ws = await import('../src/workspace.js');
const { buildServer } = await import('../src/tools.js');
const { buildPrompt } = await import('../src/runner.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const client = new Client({ name: 't', version: '0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([buildServer().connect(st), client.connect(ct)]);
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

test('canvas_link creates an edge visible in project_get', async () => {
  const { slug } = ws.createProject({ name: 'L' });
  const a = ws.writeNode(slug, { html: '<p>a</p>' }).node.id;
  const b = ws.writeNode(slug, { html: '<p>b</p>' }).node.id;
  const { edge } = await call('canvas_link', { project: slug, from: a, to: b, label: 'Sign in' });
  assert.equal(edge.from, a);
  const g = await call('project_get', { project: slug });
  assert.equal(g.edges[0].from, a);
  assert.deepEqual(g.nodes.find((n) => n.id === a).links, [{ to: b, label: 'Sign in' }]);
  const { removed } = await call('canvas_link', { project: slug, from: a, to: b, remove: true });
  assert.equal(removed.id, edge.id);
});

test('canvas_note pinned appears in project_get context; near places it', async () => {
  const { slug } = ws.createProject({ name: 'N' });
  const a = ws.writeNode(slug, { html: '<p>a</p>' }).node.id;
  const { note } = await call('canvas_note', { project: slug, text: 'Prices are in EUR', pinned: true, near: a });
  assert.equal(note.pos, null); // node has no pos yet: browser places it
  const g = await call('project_get', { project: slug });
  assert.ok(g.context.some((c) => c.text === 'Prices are in EUR'));
  assert.ok(g.notes.some((x) => x.id === note.id && x.pinned));
  ws.updateNodeMeta(slug, a, { x: 100, y: 50 });
  const { note: n2 } = await call('canvas_note', { project: slug, text: 'beside', near: a });
  assert.deepEqual(n2.pos, { x: 100 + 1440 + 48, y: 50 });
  const { note: n3 } = await call('canvas_note', { project: slug, id: n2.id, pinned: true });
  assert.equal(n3.pinned, true);
  await call('canvas_note', { project: slug, id: n2.id, remove: true });
  assert.ok(!(await call('project_get', { project: slug })).notes.some((x) => x.id === n2.id));
});

test('design_write link_from creates edge', async () => {
  const { slug } = ws.createProject({ name: 'W' });
  const a = ws.writeNode(slug, { html: '<p>a</p>' }).node.id;
  const r = await call('design_write', { project: slug, html: '<p>b</p>', link_from: a, link_label: 'Next' });
  const g = await call('project_get', { project: slug });
  assert.deepEqual(g.edges.map((e) => [e.from, e.to, e.label]), [[a, r.node.id, 'Next']]);
});

test('runner prompt includes pinned context and truncates at 12000', () => {
  const { slug } = ws.createProject({ name: 'R' });
  ws.addNote(slug, { text: 'x'.repeat(15000), pinned: true });
  const prompt = buildPrompt(ws.loadProject(slug), []);
  const i = prompt.indexOf('Product context pinned by the user (follow it):');
  assert.ok(i >= 0);
  const section = prompt.slice(i, prompt.indexOf('\n\nRequests sent', i));
  assert.ok(section.endsWith('… (truncated, see project_get context)'));
  assert.ok(section.length <= 12000);
});
