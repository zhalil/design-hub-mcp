import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snap, computeLayout, autoLayout, edgeGeometry, sectionBoxes, pushApart } from '../src/preview/static/layout.js';

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

test('a section is one block under the page linking into it, beside that page\'s other branches', () => {
  const nodes = [node('home', { createdAt: 0 }), node('login', { createdAt: 1 }), node('profile', { createdAt: 2, section: 'User' }),
    node('edit', { createdAt: 3, section: 'User' }), node('v2', { createdAt: 4, parent: 'profile' }), node('cart', { createdAt: 5, section: 'Checkout' })];
  const edges = [nav('home', 'login'), nav('home', 'profile'), nav('profile', 'edit'), nav('edit', 'cart')];
  const pos = computeLayout(nodes, edges, sizeOf);
  assert.equal(pos.profile.y, pos.login.y + 2 * 220, 'the block leaves room for its title');
  assert.ok(pos.profile.x > pos.login.x + 1440);
  assert.deepEqual([pos.edit.x, pos.edit.y], [pos.profile.x + (1440 + 140) / 2, pos.profile.y + 900 + 220], 'the section flows top down inside, centered under the profile row');
  assert.equal(pos.v2.y, pos.profile.y, 'iterations stay in their page row, in the section');
  assert.ok(pos.cart.y > pos.edit.y + 900, 'a section entered only from another section hangs under it');
  const [user, checkout] = sectionBoxes(nodes, pos);
  assert.deepEqual(user, { section: 'User', x: pos.profile.x, y: pos.profile.y, w: 2 * 1440 + 140, h: 2 * 900 + 220 });
  assert.equal(checkout.section, 'Checkout');
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

test('pushApart moves what is in the way, and what that bumps into, keeping the fixed box put', () => {
  const box = (x, y) => ({ x, y, w: 100, h: 100 });
  const moved = pushApart({ a: box(0, 0), b: box(60, 10), c: box(200, 0), far: box(0, 900) }, ['a'], 20);
  assert.deepEqual(moved.b, { x: 120, y: 10 }, 'b goes right, the shorter way out, leaving the gap');
  assert.deepEqual(moved.c, { x: 240, y: 0 }, 'c is pushed on by b');
  assert.equal(moved.a, undefined);
  assert.equal(moved.far, undefined);
});

test('an auto-placed page steps aside from a moved one lying on it', () => {
  const pos = computeLayout([node('a'), node('b', { pos: { x: 200, y: 100 } })], [], sizeOf);
  assert.deepEqual([pos.b.x, pos.b.y], [200, 100]);
  assert.ok(pos.a.y + 900 + 48 <= 100 || pos.a.x + 1440 + 48 <= 200 || pos.a.x >= 200 + 1440 + 48 || pos.a.y >= 100 + 900 + 48);
});
