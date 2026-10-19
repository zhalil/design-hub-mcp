import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snap, computeLayout, autoLayout, edgeGeometry } from '../src/preview/static/layout.js';

const sizeOf = () => ({ w: 1440, h: 900 });
const node = (id, extra = {}) => ({ id, parent: null, viewport: 'desktop', createdAt: id, ...extra });
const nav = (from, to) => ({ id: `${from}-${to}`, from, to, label: '', kind: 'nav' });

test('snap rounds to the 24px grid', () => {
  assert.equal(snap(37), 48);
  assert.equal(snap(11), 0);
});

test('next-page root sits right of its source', () => {
  const pos = computeLayout([node('a', { pos: { x: 0, y: 0 } }), node('b')], [nav('a', 'b')], sizeOf);
  assert.equal(pos.b.x, 1440 + 280);
  assert.equal(pos.b.y, 0);
});

test('nav chains resolve in edge order', () => {
  const pos = computeLayout([node('a', { pos: { x: 0, y: 0 } }), node('b'), node('c')], [nav('a', 'b'), nav('b', 'c')], sizeOf);
  assert.equal(pos.c.x, 2 * (1440 + 280));
});

test('missing source falls back to normal root placement', () => {
  const pos = computeLayout([node('b')], [nav('ghost', 'b')], sizeOf);
  assert.deepEqual(pos.b, { x: 0, y: 0, w: 1440, h: 900 });
});

test('children stack under parent as before', () => {
  const pos = computeLayout([node('a'), node('b', { parent: 'a' })], [], sizeOf);
  assert.equal(pos.b.y, 900 + 220);
});

test('autoLayout orders flow A->B->C left to right', () => {
  const nodes = [node('c', { createdAt: 1 }), node('a', { createdAt: 2 }), node('b', { createdAt: 3 }), node('z', { createdAt: 0 })];
  const pos = autoLayout(nodes, [nav('a', 'b'), nav('b', 'c')], sizeOf);
  assert.ok(pos.a.x < pos.b.x && pos.b.x < pos.c.x);
  assert.ok(pos.z.x > pos.c.x);
  assert.equal(pos.a.x % 24, 0);
});

test('autoLayout puts iterations in a column under their root', () => {
  const pos = autoLayout([node('a'), node('a2', { parent: 'a' })], [], sizeOf);
  assert.equal(pos.a2.x, pos.a.x);
  assert.ok(pos.a2.y > pos.a.y);
});

test('edgeGeometry picks facing sides', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const g = edgeGeometry(a, { x: 500, y: 0, w: 100, h: 100 });
  assert.ok(g.d.startsWith('M100,50'));
  assert.equal(g.lx, 300);
  const left = edgeGeometry({ x: 500, y: 0, w: 100, h: 100 }, a);
  assert.ok(left.d.startsWith('M500,50'));
});
