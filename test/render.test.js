import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { browserAvailable, screenshot, lint, closeBrowser } from '../src/render.js';

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>t</title></head>
<body><h1>Hello</h1><img src="/missing.png" alt="missing"><script>console.error('boom from page')</script></body></html>`;

test('screenshot and lint render in a real browser over CDP', async (t) => {
  const avail = await browserAvailable();
  if (!avail.ok) return t.skip(`no browser: ${avail.error}`);
  t.after(closeBrowser);
  t.diagnostic(`browser: ${avail.browser}`);
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;

  const shot = await screenshot(url, 'mobile');
  assert.ok(Buffer.isBuffer(shot.buffer));
  assert.equal(shot.buffer[0], 0xff);
  assert.equal(shot.buffer[1], 0xd8);
  assert.equal(shot.width, 390);

  const r = await lint({ html, url });
  assert.equal(r.rendered, true, r.renderError);
  const ce = r.issues.find((i) => i.rule === 'console-errors');
  assert.ok(ce, JSON.stringify(r.issues));
  assert.match(ce.details.join('\n'), /boom from page/);
  assert.ok(r.issues.some((i) => i.rule === 'failed-requests' && i.details.some((d) => d.includes('/missing.png'))));
});
