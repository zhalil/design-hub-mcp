import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DESIGN_HUB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-home-'));
process.env.DESIGN_HUB_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-ws-'));
const ws = await import('../src/workspace.js');

function setup() {
  const { slug } = ws.createProject({ name: 'T' });
  const a = ws.writeNode(slug, { html: '<p>a</p>' }).node.id;
  const b = ws.writeNode(slug, { html: '<p>b</p>' }).node.id;
  return { slug, a, b };
}

test('addEdge links two nodes', () => {
  const { slug, a, b } = setup();
  const e = ws.addEdge(slug, { from: a, to: b });
  assert.partialDeepStrictEqual(e, { from: a, to: b, kind: 'nav' });
  assert.equal(ws.loadProject(slug).edges.length, 1);
});

test('addEdge rejects self and duplicate', () => {
  const { slug, a, b } = setup();
  assert.throws(() => ws.addEdge(slug, { from: a, to: a }));
  assert.throws(() => ws.addEdge(slug, { from: a, to: 'nope' }));
  ws.addEdge(slug, { from: a, to: b });
  assert.throws(() => ws.addEdge(slug, { from: a, to: b }));
});

test('updateEdge and deleteEdge', () => {
  const { slug, a, b } = setup();
  const e = ws.addEdge(slug, { from: a, to: b });
  assert.equal(ws.updateEdge(slug, e.id, { label: 'go' }).label, 'go');
  assert.equal(ws.deleteEdge(slug, e.id).id, e.id);
  assert.equal(ws.loadProject(slug).edges.length, 0);
});

test('deleteNode removes edges and restoreNode brings everything back', () => {
  const { slug, a, b } = setup();
  const c = ws.writeNode(slug, { html: '<p>c</p>', parent: a }).node.id;
  ws.addEdge(slug, { from: a, to: b });
  ws.selectNode(slug, a);
  ws.deleteNode(slug, a);
  let p = ws.loadProject(slug);
  assert.equal(p.edges.length, 0);
  assert.equal(p.nodes.find((n) => n.id === c).parent, null);
  const n = ws.restoreNode(slug, a);
  p = ws.loadProject(slug);
  assert.equal(n.id, a);
  assert.equal(p.nodes.find((x) => x.id === c).parent, a);
  assert.equal(p.edges.length, 1);
  assert.equal(p.selected, a);
  assert.ok(fs.existsSync(ws.nodeFile(slug, n)));
  assert.equal(p.trash.length, 0);
});

test('restoreNode unknown id throws', () => {
  const { slug } = setup();
  assert.throws(() => ws.restoreNode(slug, 'n99'));
});

test('notes: add/update/delete and pinnedContext', () => {
  const { slug } = setup();
  const n = ws.addNote(slug, { text: 'hi', pinned: true });
  assert.equal(n.color, 'yellow');
  assert.equal(ws.pinnedContext(ws.loadProject(slug)).length, 2);
  assert.equal(ws.updateNote(slug, n.id, { pinned: false }).pinned, false);
  assert.equal(ws.pinnedContext(ws.loadProject(slug)).length, 1);
  assert.equal(ws.deleteNote(slug, n.id).id, n.id);
  assert.equal(ws.loadProject(slug).notes.length, 1);
});

test('createProject adds the context note', () => {
  const { slug } = ws.createProject({ name: 'Ctx', brief: 'B' });
  const [n] = ws.loadProject(slug).notes;
  assert.equal(n.text, 'Design Context\n\nB\n\nTokens and styles: DESIGN.md');
  assert.deepEqual(n.pos, { x: -420, y: 0 });
  assert.deepEqual(n.size, { w: 360, h: 280 });
  assert.equal(n.pinned, true);
});

test('addNote rejects unknown colour', () => {
  const { slug } = setup();
  assert.throws(() => ws.addNote(slug, { color: 'teal' }));
});

test('writeNode linkFrom creates nav edge', () => {
  const { slug, a } = setup();
  const { node } = ws.writeNode(slug, { html: 'x', linkFrom: a, linkLabel: 'Next' });
  const [e] = ws.loadProject(slug).edges;
  assert.partialDeepStrictEqual(e, { from: a, to: node.id, label: 'Next' });
});

test('old project without edges/notes loads', () => {
  const dir = path.join(process.env.DESIGN_HUB_WORKSPACE, 'old');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ slug: 'old', name: 'old' }));
  const p = ws.loadProject('old');
  assert.deepEqual([p.edges, p.notes, p.trash], [[], [], []]);
});

test('addRequest next-page keeps label', () => {
  const { slug, a } = setup();
  const r = ws.addRequest(slug, { type: 'next-page', nodeId: a, label: 'Pricing' });
  assert.equal(r.label, 'Pricing');
});

test('updateNodeMeta with null x/y clears pos; unknown viewport rejected', () => {
  const { slug, a } = setup();
  ws.updateNodeMeta(slug, a, { x: 10, y: 20 });
  assert.deepEqual(ws.getNode(ws.loadProject(slug), a).pos, { x: 10, y: 20 });
  ws.updateNodeMeta(slug, a, { x: null, y: null });
  assert.equal('pos' in ws.getNode(ws.loadProject(slug), a), false);
  assert.throws(() => ws.updateNodeMeta(slug, a, { viewport: 'watch' }), /viewport/);
});

test('writeNode linkFrom: existing edge is not duplicated, returned project has the edge', () => {
  const { slug, a, b } = setup();
  ws.addEdge(slug, { from: a, to: b });
  const { project } = ws.writeNode(slug, { html: 'x', node: b, linkFrom: a });
  assert.equal(project.edges.filter((e) => e.from === a && e.to === b).length, 1);
  assert.equal(ws.loadProject(slug).edges.length, 1);
  const r = ws.writeNode(slug, { html: 'y', linkFrom: a });
  assert.ok(r.project.edges.some((e) => e.from === a && e.to === r.node.id));
});

test('writeNode linkFrom self or unknown throws before writing', () => {
  const { slug, a } = setup();
  const file = ws.nodeFile(slug, ws.getNode(ws.loadProject(slug), a));
  assert.throws(() => ws.writeNode(slug, { html: 'changed', node: a, linkFrom: a }), /itself/);
  assert.throws(() => ws.writeNode(slug, { html: 'changed', node: a, linkFrom: 'nope' }));
  assert.equal(ws.getNode(ws.loadProject(slug), a).revision, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '<p>a</p>');
});

test('updateNote coerces text/pinned; updateEdge caps label', () => {
  const { slug, a, b } = setup();
  const n = ws.addNote(slug, { text: 'hi' });
  const u = ws.updateNote(slug, n.id, { text: 42, pinned: 'yes' });
  assert.equal(u.text, '42');
  assert.equal(u.pinned, true);
  const e = ws.addEdge(slug, { from: a, to: b });
  assert.equal(ws.updateEdge(slug, e.id, { label: 'x'.repeat(500) }).label.length, 120);
});
