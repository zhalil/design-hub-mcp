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

test('next page sits below its source', () => {
  const pos = computeLayout([node('a', { pos: { x: 0, y: 0 } }), node('b')], [nav('a', 'b')], sizeOf);
  assert.equal(pos.b.x, 0);
  assert.equal(pos.b.y, 900 + 220);
});

test('nav chains go down level by level', () => {
  const pos = computeLayout([node('a', { pos: { x: 0, y: 0 } }), node('b'), node('c')], [nav('a', 'b'), nav('b', 'c')], sizeOf);
  assert.equal(pos.c.y, 2 * (900 + 220));
});

test('missing source falls back to normal root placement', () => {
  const pos = computeLayout([node('b')], [nav('ghost', 'b')], sizeOf);
  assert.deepEqual(pos.b, { x: 0, y: 0, w: 1440, h: 900 });
});

test('a page with two links branches: targets side by side, source centered above', () => {
  const pos = computeLayout([node('a'), node('b'), node('c')], [nav('a', 'b'), nav('a', 'c')], sizeOf);
  assert.equal(pos.b.y, pos.c.y);
  assert.ok(pos.b.y > pos.a.y);
  assert.equal(pos.c.x, pos.b.x + 1440 + 140);
  assert.equal(pos.a.x + 720, (pos.b.x + pos.c.x + 1440) / 2);
});

test('a page linked from two branches sits below both, under the deeper one; levels share a y', () => {
  // home -> catalog -> product -> cart, home -> cart, home -> about
  const ids = ['home', 'catalog', 'about', 'product', 'cart'];
  const pos = computeLayout(ids.map((id, i) => node(id, { createdAt: i })),
    [nav('home', 'catalog'), nav('home', 'cart'), nav('home', 'about'), nav('catalog', 'product'), nav('product', 'cart')], sizeOf);
  assert.equal(pos.catalog.y, pos.about.y);
  assert.ok(pos.cart.y > pos.product.y && pos.product.y > pos.catalog.y);
  assert.equal(pos.cart.x, pos.product.x);
});

test('iterations stand in their page row, to the right', () => {
  const pos = computeLayout([node('a'), node('b', { parent: 'a' })], [], sizeOf);
  assert.equal(pos.b.y, pos.a.y);
  assert.equal(pos.b.x, 1440 + 140);
});

test('a cycle still lays out as a tree', () => {
  const pos = computeLayout([node('a'), node('b')], [nav('a', 'b'), nav('b', 'a')], sizeOf);
  assert.ok(pos.b.y > pos.a.y);
});

test('autoLayout orders flow A->B->C top to bottom, unlinked pages after', () => {
  const nodes = [node('c', { createdAt: 1 }), node('a', { createdAt: 2 }), node('b', { createdAt: 3 }), node('z', { createdAt: 0 })];
  const pos = autoLayout(nodes, [nav('a', 'b'), nav('b', 'c')], sizeOf);
  assert.ok(pos.a.y < pos.b.y && pos.b.y < pos.c.y);
  assert.ok(pos.z.x > pos.c.x);
  assert.equal(pos.a.x % 24, 0);
});

test('autoLayout ignores saved positions', () => {
  const pos = autoLayout([node('a', { pos: { x: 5000, y: 5000 } }), node('a2', { parent: 'a' })], [], sizeOf);
  assert.deepEqual(pos.a, { x: 0, y: 0 });
  assert.equal(pos.a2.y, 0);
});

test('edgeGeometry picks facing sides', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const g = edgeGeometry(a, { x: 500, y: 0, w: 100, h: 100 });
  assert.ok(g.d.startsWith('M100,50'));
  assert.equal(g.lx, 300);
  const left = edgeGeometry({ x: 500, y: 0, w: 100, h: 100 }, a);
  assert.ok(left.d.startsWith('M500,50'));
  assert.ok(edgeGeometry(a, { x: 2000, y: 300, w: 100, h: 100 }).d.startsWith('M50,100'), 'a lower row: bottom to top, however far aside');
});
