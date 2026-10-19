import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../src/preview/static/history.js';

const step = (log, label) => ({ label, undo: () => log.push(`u${label}`), redo: () => log.push(`r${label}`) });

test('push/undo/redo call the right closures', async () => {
  const log = []; const h = createHistory();
  h.push(step(log, 1));
  assert.equal(await h.undo(), 1);
  assert.equal(await h.redo(), 1);
  assert.deepEqual(log, ['u1', 'r1']);
  assert.equal(await h.redo(), null);
});

test('push after undo clears redo', async () => {
  const log = []; const h = createHistory();
  h.push(step(log, 1)); await h.undo(); h.push(step(log, 2));
  assert.equal(h.canRedo(), false);
});

test('limit drops the oldest step', async () => {
  const log = []; const h = createHistory(2);
  h.push(step(log, 1)); h.push(step(log, 2)); h.push(step(log, 3));
  assert.equal(await h.undo(), 3); assert.equal(await h.undo(), 2);
  assert.equal(h.canUndo(), false); assert.equal(await h.undo(), null);
});
