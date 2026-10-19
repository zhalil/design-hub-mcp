// Rendering checks: screenshots and lint run in a real browser (playwright-core),
// plus static checks of the HTML source that work without any browser.
// The anti-slop checks implement OpenDesign's craft/anti-ai-slop.md P0/P1 rules
// and huashu-design's "Claude default look" tell.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { VIEWPORTS } from './workspace.js';
import { enabledSources, sourceDir } from './sources.js';

let browserPromise = null;
let idleTimer = null;
let launchInfo = null;

async function launch() {
  let pw;
  try { pw = await import('playwright-core'); } catch {
    throw new Error('playwright-core is not installed. Run `npm install` in the design-hub folder.');
  }
  const { chromium } = pw;
  const attempts = [];
  if (process.env.DESIGN_HUB_CHROME) attempts.push({ label: 'DESIGN_HUB_CHROME', opts: { executablePath: process.env.DESIGN_HUB_CHROME } });
  attempts.push({ label: 'playwright chromium', opts: {} });
  attempts.push({ label: 'Google Chrome', opts: { channel: 'chrome' } });
  attempts.push({ label: 'Microsoft Edge', opts: { channel: 'msedge' } });
  const errors = [];
  for (const a of attempts) {
    try {
      const b = await chromium.launch({ headless: true, ...a.opts });
      launchInfo = a.label;
      return b;
    } catch (e) { errors.push(`${a.label}: ${String(e.message).split('\n')[0]}`); }
  }
  throw new Error(`No browser available for rendering. Install Chrome, or run \`npx playwright install chromium\`, or set DESIGN_HUB_CHROME.\n${errors.join('\n')}`);
}

async function getBrowser() {
  clearTimeout(idleTimer);
  if (!browserPromise) browserPromise = launch().catch((e) => { browserPromise = null; throw e; });
  const b = await browserPromise;
  idleTimer = setTimeout(async () => { const p = browserPromise; browserPromise = null; try { (await p)?.close(); } catch { /* ignore */ } }, 90000);
  return b;
}

export async function browserAvailable() {
  try { await getBrowser(); return { ok: true, browser: launchInfo }; } catch (e) { return { ok: false, error: e.message }; }
}

async function withPage(url, viewport, fn) {
  const browser = await getBrowser();
  const vp = VIEWPORTS[viewport] || VIEWPORTS.desktop;
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: viewport === 'mobile', hasTouch: viewport !== 'desktop' });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 300)}`));
  page.on('requestfailed', (r) => failedRequests.push(`${r.url().slice(0, 200)} (${r.failure()?.errorText || 'failed'})`));
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.url().slice(0, 200)} → ${r.status()}`); });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(600); // fonts, entrance animations
    return await fn(page, { consoleErrors, failedRequests, viewport: vp });
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function screenshot(url, viewport = 'desktop', { maxHeight = 2600, quality = 72 } = {}) {
  return withPage(url, viewport, async (page, { viewport: vp }) => {
    const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0));
    const clipH = Math.min(height, maxHeight);
    const buf = await page.screenshot({ type: 'jpeg', quality, clip: { x: 0, y: 0, width: vp.width, height: Math.max(clipH, 1) }, fullPage: clipH > vp.height });
    return { buffer: buf, width: vp.width, height: clipH, fullHeight: height, truncated: height > maxHeight };
  });
}

// Runs inside the page.
const PAGE_LINT = () => {
  const parse = (c) => {
    const m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const l1 = lum(a); const l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const hex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.');
    return s;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const bgOf = (el) => {
    let e = el;
    while (e && e.nodeType === 1) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { unknown: true };
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0.85) return c;
      e = e.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  const out = { contrast: [], smallText: [], tapTargets: [], brokenImages: [], missingAlt: [], indigo: [], emoji: [], leftBorderCards: [], gradients: [], overflowX: false, pageHeight: 0 };
  const vw = window.innerWidth;
  out.overflowX = document.documentElement.scrollWidth > vw + 1;
  out.pageHeight = document.documentElement.scrollHeight;

  const all = [...document.body.querySelectorAll('*')].slice(0, 4000);
  const INDIGO = new Set(['#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#8b5cf6', '#7c3aed', '#a855f7']);
  const emojiRe = /\p{Extended_Pictographic}/u;
  const seenContrast = new Set();

  for (const el of all) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (ownText) {
      const size = parseFloat(cs.fontSize);
      if (size < 12 && out.smallText.length < 8) out.smallText.push({ el: describe(el), size, text: ownText.slice(0, 40) });
      const fg = parse(cs.color);
      const bg = bgOf(el);
      if (fg && !bg.unknown) {
        const r = ratio(fg, bg);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        const need = large ? 3 : 4.5;
        const key = `${hex(fg)}/${hex(bg)}`;
        if (r < need && !seenContrast.has(key) && out.contrast.length < 10) {
          seenContrast.add(key);
          out.contrast.push({ el: describe(el), ratio: Math.round(r * 100) / 100, need, fg: hex(fg), bg: hex(bg), text: ownText.slice(0, 40) });
        }
      }
      if (/^(H[1-6]|BUTTON|LI|A)$/.test(el.tagName) && emojiRe.test(ownText) && out.emoji.length < 8) out.emoji.push({ el: describe(el), text: ownText.slice(0, 40) });
    }
    if (String(el.className || '').toString().includes('icon') && emojiRe.test(el.textContent || '') && out.emoji.length < 8) out.emoji.push({ el: describe(el), text: (el.textContent || '').trim().slice(0, 20) });
    for (const prop of ['backgroundColor', 'color', 'borderTopColor']) {
      const c = parse(cs[prop]);
      if (c && c.a > 0.5 && INDIGO.has(hex(c)) && out.indigo.length < 6) out.indigo.push({ el: describe(el), prop, color: hex(c) });
    }
    const bl = parseFloat(cs.borderLeftWidth);
    if (bl >= 2 && parseFloat(cs.borderTopWidth) === 0 && parseFloat(cs.borderRightWidth) === 0 && parseFloat(cs.borderTopLeftRadius) > 0) {
      const c = parse(cs.borderLeftColor);
      if (c && (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) > 40 && out.leftBorderCards.length < 5) out.leftBorderCards.push({ el: describe(el), color: hex(c) });
    }
    const r = el.getBoundingClientRect();
    if (r.top < 900 && cs.backgroundImage.includes('linear-gradient') && r.width > vw * 0.5 && out.gradients.length < 4) {
      out.gradients.push({ el: describe(el), value: cs.backgroundImage.slice(0, 160) });
    }
    if (el.tagName === 'IMG') {
      if (el.complete && el.naturalWidth === 0 && out.brokenImages.length < 8) out.brokenImages.push(el.getAttribute('src')?.slice(0, 120));
      if (!el.hasAttribute('alt') && out.missingAlt.length < 8) out.missingAlt.push(el.getAttribute('src')?.slice(0, 120));
    }
    if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.getAttribute('role') === 'button') {
      if ((r.width < 44 || r.height < 44) && r.width > 0 && out.tapTargets.length < 10) out.tapTargets.push({ el: describe(el), size: `${Math.round(r.width)}×${Math.round(r.height)}`, text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30) });
    }
  }
  const bodyBg = parse(getComputedStyle(document.body).backgroundColor) || parse(getComputedStyle(document.documentElement).backgroundColor);
  out.bodyBg = bodyBg ? hex(bodyBg) : null;
  return out;
};

const near = (hexA, hexB, tol = 18) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(hexA); const b = p(hexB);
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
};

/** Checks that only need the HTML source. */
export function staticLint(html) {
  const issues = [];
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const add = (severity, rule, message, source) => issues.push({ severity, rule, message, source });

  if (/lorem ipsum|feature (one|two|three)\b|placeholder text|sample content/i.test(text)) add('P0', 'filler-copy', 'Filler copy found (lorem ipsum / "feature one" / "placeholder text"). Write real copy or leave a labelled gap.', 'open-design/anti-ai-slop');
  const metric = text.match(/\b\d+(\.\d+)?\s?[x×]\s+(faster|more|better|cheaper|productive)\b|99\.9+\s?%\s*uptime/i);
  if (metric) add('P0', 'invented-metrics', `Possibly invented metric: "${metric[0]}". Use a real source or a labelled placeholder.`, 'open-design/anti-ai-slop');
  if (/(unsplash\.com|placehold\.co|placekitten\.com|picsum\.photos|via\.placeholder\.com)/i.test(html)) add('P1', 'placeholder-cdn', 'External placeholder image CDN used. Fragile and obvious — use a styled placeholder block instead.', 'open-design/anti-ai-slop');
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n') + '\n' + [...html.matchAll(/style="([^"]*)"/gi)].map((m) => m[1]).join('\n');
  const outsideRoot = styles.replace(/:root\s*(\[[^\]]*\])?\s*\{[^}]*\}/g, '');
  const hexes = new Set((outsideRoot.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) || []).map((h) => h.toLowerCase()));
  if (hexes.size > 12) add('P1', 'raw-hex', `${hexes.size} distinct raw hex colors outside :root — tokens are not being used. Move colors to CSS variables from DESIGN.md.`, 'open-design/anti-ai-slop');
  const indigoHits = [...new Set((styles.match(/#(6366f1|4f46e5|4338ca|3730a3|8b5cf6|7c3aed|a855f7)\b/gi) || []).map((h) => h.toLowerCase()))];
  if (indigoHits.length) add('P0', 'default-indigo', `Default Tailwind indigo/violet in styles (${indigoHits.join(', ')}) — the textbook AI tell. Use the DESIGN.md accent.`, 'open-design/anti-ai-slop');
  const emojiInTags = html.match(/<(h[1-6]|button|li)[^>]*>[^<]*\p{Extended_Pictographic}/u);
  if (emojiInTags) add('P0', 'emoji-icons', 'Emoji used as icons in headings/buttons/list items. Use monoline SVG icons with currentColor.', 'open-design/anti-ai-slop');
  if (!/<meta[^>]+name=["']viewport/i.test(html)) add('P1', 'viewport-meta', 'Missing <meta name="viewport"> — mobile preview will be zoomed out.', 'design-hub');
  return issues;
}

/** Full lint: static checks + rendered checks (if a browser is available). */
export async function lint({ html, url, viewport = 'desktop' }) {
  const issues = staticLint(html);
  let rendered = null;
  let renderError = null;
  if (url) {
    try {
      rendered = await withPage(url, viewport, async (page, ctx) => {
        const r = await page.evaluate(PAGE_LINT);
        return { ...r, consoleErrors: ctx.consoleErrors.slice(0, 10), failedRequests: [...new Set(ctx.failedRequests)].slice(0, 10) };
      });
    } catch (e) { renderError = e.message; }
  }
  const add = (severity, rule, message, details, source = 'design-hub') => issues.push({ severity, rule, message, details, source });
  if (rendered) {
    if (rendered.consoleErrors.length) add('P0', 'console-errors', `${rendered.consoleErrors.length} console error(s).`, rendered.consoleErrors);
    if (rendered.failedRequests.length) add('P0', 'failed-requests', 'Some resources failed to load.', rendered.failedRequests);
    if (rendered.brokenImages.length) add('P0', 'broken-images', 'Broken images.', rendered.brokenImages);
    if (rendered.overflowX) add('P0', 'horizontal-overflow', `Page scrolls horizontally at ${viewport} width.`);
    if (rendered.contrast.length) add('P0', 'contrast', 'Text below WCAG AA contrast.', rendered.contrast, 'ui-ux-pro-max/ux-guidelines');
    if (rendered.smallText.length) add('P1', 'small-text', 'Text smaller than 12px.', rendered.smallText, 'ui-ux-pro-max/ux-guidelines');
    if (viewport === 'mobile' && rendered.tapTargets.length) add('P1', 'tap-targets', 'Interactive elements smaller than 44×44px on mobile.', rendered.tapTargets, 'ui-ux-pro-max/ux-guidelines');
    if (rendered.missingAlt.length) add('P1', 'img-alt', 'Images without alt attribute.', rendered.missingAlt, 'craft/accessibility-baseline');
    if (rendered.indigo.length) add('P0', 'default-indigo', 'Default Tailwind indigo/violet rendered as a color.', rendered.indigo, 'open-design/anti-ai-slop');
    if (rendered.emoji.length) add('P0', 'emoji-icons', 'Emoji rendered as icons.', rendered.emoji, 'open-design/anti-ai-slop');
    if (rendered.leftBorderCards.length) add('P0', 'left-border-card', 'Rounded card with a colored left-border accent (the "AI dashboard tile").', rendered.leftBorderCards, 'open-design/anti-ai-slop');
    const hueGrad = rendered.gradients.filter((g) => /rgb/.test(g.value));
    if (hueGrad.length) add('P1', 'hero-gradient', 'Large gradient in the first screen — check it is not the purple→blue "trust" gradient.', hueGrad, 'open-design/anti-ai-slop');
    if (rendered.bodyBg && near(rendered.bodyBg, '#f4f1ea', 14)) add('P1', 'claude-default-look', 'Warm cream background (#F4F1EA family) — the model\'s default aesthetic. Fine only if the subject asks for it.', [rendered.bodyBg], 'huashu-design');
  }
  // a rendered finding (with details) supersedes the static one for the same rule
  const detailed = new Set(issues.filter((i) => i.details).map((i) => i.rule));
  const unique = issues.filter((i) => i.details || !detailed.has(i.rule));
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const i of unique) counts[i.severity] = (counts[i.severity] || 0) + 1;
  return { viewport, rendered: Boolean(rendered), renderError, counts, issues: unique };
}

/** Optionally run huashu-design's own design_lint.py (needs python playwright). */
export function huashuLintScript() {
  for (const src of enabledSources()) {
    const rel = src.provides?.lint;
    if (rel && fs.existsSync(path.join(sourceDir(src.id), rel))) return path.join(sourceDir(src.id), rel);
  }
  return null;
}

export function runHuashuLint(files, python = ['python3']) {
  const script = huashuLintScript();
  if (!script) return Promise.reject(new Error('huashu-design design_lint.py not found'));
  const args = files.length > 1 ? ['compare', ...files] : ['check', ...files, '--json'];
  return new Promise((resolve, reject) => {
    execFile(python[0], [...python.slice(1), script, ...args], { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, cwd: path.dirname(script) },
      (err, stdout, stderr) => (err && !stdout ? reject(new Error((stderr || err.message).toString().split('\n').slice(-4).join(' | '))) : resolve(stdout)));
  });
}
