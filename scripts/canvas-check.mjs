// Headless browser check of the live canvas: zoom/wheel behaviour and the Superdesign-style shell.
// Usage: node scripts/canvas-check.mjs [screenshot.png]
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-canvas-check-'));
process.env.DESIGN_HUB_HOME = path.join(tmp, 'home');
process.env.DESIGN_HUB_WORKSPACE = path.join(tmp, 'ws');
process.env.DESIGN_HUB_PORT = '7797';
process.env.DESIGN_HUB_RUNNER = 'false';
const ws = await import('../src/workspace.js');
const { startPreview, stopPreview } = await import('../src/preview/http.js');
const { chromium } = await import('playwright-core');

const p = ws.createProject({ name: 'Canvas check' });
const { node: a } = ws.writeNode(p.slug, { html: '<h1>A</h1>', label: 'A' });
ws.writeNode(p.slug, { html: '<h1>B</h1>', label: 'B', parent: a.id });
const { node: c } = ws.writeNode(p.slug, { html: '<h1>C</h1>', label: 'C' }); // a second root: the rightmost frame
const info = await startPreview();
let browser;
for (const o of [{ channel: 'chrome' }, {}, { channel: 'msedge' }]) { try { browser = await chromium.launch(o); break; } catch { /* try the next one */ } }
assert.ok(browser, 'no Chromium-based browser found (npx playwright install chromium)');

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${info.url}/p/${p.slug}`);
  await page.waitForSelector('.frame iframe');
  await page.waitForTimeout(500);
  const scale = () => page.$eval('#world', (w) => Number(/scale\(([\d.]+)\)/.exec(w.style.transform)[1]));
  const vw = () => page.$eval('#world', (w) => w.style.transform);
  const tx = (t) => /translate\(([-\d.]+)px, ([-\d.]+)px/.exec(t).slice(1).map(Number);
  const near = (x, y) => Math.abs(x - y) < 0.01;
  const settle = () => page.waitForTimeout(800);

  // ---- Agent panel: hidden by default, toggled by #agent-btn, holds the composer
  assert.ok(await page.$('#agent'), '#agent exists');
  assert.ok(await page.isHidden('#agent'), '#agent is hidden by default');
  await page.click('#agent-btn');
  assert.ok(await page.isVisible('#agent'), '#agent-btn opens the Agent panel');
  assert.ok(await page.$('#agent #prompt'), '#prompt lives inside #agent');
  await page.click('#agent-btn');
  assert.ok(await page.isHidden('#agent'), '#agent-btn closes the Agent panel');

  // ---- minimap
  const mm = await page.$eval('#minimap', (c) => { const r = c.getBoundingClientRect(); return { w: r.width, h: r.height }; });
  assert.ok(mm.w > 0 && mm.h > 0, '#minimap has a size');
  const t9 = await vw();
  await page.click('#minimap', { position: { x: 4, y: 4 } });
  assert.notEqual(await vw(), t9, 'clicking the minimap recentres the view');
  await page.click('#fit-btn'); await settle();

  // ---- zoom: smooth, bounded per notch, Ctrl+wheel / Ctrl+= never reach the browser
  const s0 = await scale();
  const prevented = await page.evaluate(() => {
    const e = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 640, clientY: 400, bubbles: true, cancelable: true });
    document.querySelector('#mat').dispatchEvent(e);
    return e.defaultPrevented;
  });
  assert.ok(prevented, 'ctrl+wheel must be preventDefault-ed');
  await page.waitForTimeout(30);
  const mid = await scale();
  await settle();
  const s1 = await scale();
  assert.ok(mid > s0 && mid < s1, 'zoom animates through intermediate scales');
  assert.ok(Math.abs(s1 / s0 - Math.exp(0.2)) < 0.01, 'one notch is a ~22% step');
  assert.equal(await page.$eval('#world', (w) => w.style.willChange), '', 'layer is released after the animation');
  const keyPrevented = await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true, cancelable: true });
    dispatchEvent(e); return e.defaultPrevented;
  });
  assert.ok(keyPrevented, 'ctrl+= must not zoom the page');
  await settle();
  // Ctrl+wheel from inside a frame is forwarded to the canvas
  const s2 = await scale();
  const fwd = await page.frames()[1].evaluate(() => {
    const e = new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, clientX: 10, clientY: 10, bubbles: true, cancelable: true });
    document.dispatchEvent(e); return e.defaultPrevented;
  });
  await settle();
  assert.ok(fwd && await scale() < s2, 'ctrl+wheel inside a frame zooms the canvas out');
  // plain wheel zooms, Shift+wheel pans x, Alt+wheel pans y
  const wheel = (o) => page.evaluate((o) => document.querySelector('#mat').dispatchEvent(new WheelEvent('wheel', { clientX: 640, clientY: 400, bubbles: true, cancelable: true, ...o })), o);
  const s4 = await scale(); await wheel({ deltaY: -100 }); await settle();
  assert.ok(await scale() > s4, 'plain wheel zooms in');
  const t0 = tx(await vw()); await wheel({ deltaX: 50, shiftKey: true }); const t1 = tx(await vw());
  assert.ok(near(t1[0], t0[0] - 50) && near(t1[1], t0[1]), 'shift+wheel pans horizontally');
  await wheel({ deltaY: 40, altKey: true }); const t2 = tx(await vw());
  assert.ok(near(t2[1], t1[1] - 40) && near(t2[0], t1[0]), 'alt+wheel pans vertically');

  // ---- zoom menu presets
  await page.click('#zoom-menu');
  await page.click('#zoom-presets button:text-is("300%")');
  await settle();
  assert.equal(await page.textContent('#zoom-level'), '300%', 'the 300% preset zooms to 300%');
  await page.click('#fit-btn'); await settle();

  // ---- hand tool: dragging over a frame pans and does not select it
  await page.keyboard.press('Escape');
  await page.keyboard.press('h');
  assert.equal(await page.getAttribute('[data-tool="hand"]', 'aria-pressed'), 'true', 'H picks the hand tool');
  const box = await page.locator(`.frame[data-id="${a.id}"] .shield`).boundingBox();
  const drag = async (x, y, dx, dy) => {
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 }); await page.mouse.move(x + dx, y + dy, { steps: 4 });
    await page.mouse.up();
  };
  const h0 = tx(await vw());
  await drag(box.x + box.width / 2, box.y + box.height / 2, 120, 80);
  const h1 = tx(await vw());
  assert.ok(near(h1[0], h0[0] + 120) && near(h1[1], h0[1] + 80), 'hand drag pans the mat');
  assert.equal(await page.$('.frame.selected'), null, 'hand drag does not select');
  await page.keyboard.press('v');
  assert.equal(await page.getAttribute('[data-tool="select"]', 'aria-pressed'), 'true', 'V picks the select tool');

  // ---- View mode: a label drag does not move the frame (Edit mode does)
  const left = () => page.$eval(`.frame[data-id="${a.id}"]`, (el) => el.style.left);
  const label = async () => { const b = await page.locator(`.frame[data-id="${a.id}"] .frame-label .name`).boundingBox(); return [b.x + 4, b.y + b.height / 2]; };
  const l0 = await left();
  await drag(...await label(), 100, 0);
  const l1 = await left();
  assert.notEqual(l1, l0, 'edit mode: a label drag moves the frame');
  await page.click('#mode [data-mode="view"]');
  await drag(...await label(), 100, 0);
  assert.equal(await left(), l1, 'view mode: a label drag does not move the frame');

  assert.deepEqual(errors, [], 'no script errors on the page');
  // ---- frame toolbar stays clickable with the Agent panel open (not under it or the minimap)
  await page.click('#mode [data-mode="edit"]');
  await page.click('#agent-btn'); await page.click('#fit-btn'); await settle();
  await page.click(`.frame[data-id="${c.id}"] .shield`);
  const onTop = await page.evaluate(() => {
    const b = document.querySelector('#frame-tools').lastElementChild.getBoundingClientRect();
    return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === document.querySelector('#frame-tools').lastElementChild;
  });
  assert.ok(onTop, 'the last frame toolbar button is not covered by a panel');
  const labelFree = await page.evaluate((id) => {
    const l = document.querySelector(`.frame[data-id="${id}"] .frame-label .name`).getBoundingClientRect();
    return document.elementFromPoint(l.x + 2, l.y + l.height / 2)?.closest('.frame-label') !== null;
  }, c.id);
  assert.ok(labelFree, 'after Fit the frame toolbar does not cover the frame label');

  if (process.argv[2]) {
    await page.screenshot({ path: process.argv[2] });
  }
} finally {
  await browser.close();
  await stopPreview();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('canvas check ok');
process.exit(0);
