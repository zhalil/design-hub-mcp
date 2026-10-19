import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DESIGN_HUB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-home-'));
process.env.DESIGN_HUB_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-ws-'));
process.env.DESIGN_HUB_PORT = '7795';
process.env.DESIGN_HUB_RUNNER = 'false';
const ws = await import('../src/workspace.js');
const { startPreview, stopPreview } = await import('../src/preview/http.js');
const { url } = await startPreview();
after(() => stopPreview());

const call = async (method, p, body) => {
  const r = await fetch(url + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

test('edges, notes and restore endpoints', async () => {
  const { slug } = ws.createProject({ name: 'T' });
  const a = ws.writeNode(slug, { html: '<p>a</p>' }).node.id;
  const b = ws.writeNode(slug, { html: '<p>b</p>' }).node.id;
  const base = `/api/p/${slug}`;

  const e = await call('POST', `${base}/edges`, { from: a, to: b });
  assert.equal(e.status, 201);
  const dup = await call('POST', `${base}/edges`, { from: a, to: b });
  assert.equal(dup.status, 400);
  assert.ok(dup.json.error);

  const proj = await call('GET', base);
  assert.equal(proj.json.edges.length, 1);
  assert.equal('trash' in proj.json, false);

  const n = await call('POST', `${base}/notes`, { text: 'hi' });
  assert.equal(n.status, 201);
  const pn = await call('PATCH', `${base}/notes/${n.json.id}`, { pinned: true });
  assert.equal(pn.json.pinned, true);

  await call('DELETE', `${base}/nodes/${a}`);
  assert.ok(!(await call('GET', base)).json.nodes.some((x) => x.id === a));
  const r = await call('POST', `${base}/nodes/${a}/restore`);
  assert.equal(r.status, 200);
  assert.ok((await call('GET', base)).json.nodes.some((x) => x.id === a));
});
