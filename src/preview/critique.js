// Server-rendered 5-dimension critique report (rubric from OpenDesign's critique template,
// which itself follows huashu-design's expert-review flow).
const DIMS = [
  ['philosophy', 'Philosophy consistency'],
  ['hierarchy', 'Visual hierarchy'],
  ['detail', 'Detail execution'],
  ['functionality', 'Functionality'],
  ['innovation', 'Innovation'],
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function band(score) {
  if (score <= 4) return 'Broken';
  if (score <= 6) return 'Functional';
  if (score <= 8) return 'Strong';
  return 'Exceptional';
}

function radar(scores) {
  const cx = 160; const cy = 150; const R = 110;
  const pt = (i, v) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / DIMS.length;
    return [cx + Math.cos(a) * R * (v / 10), cy + Math.sin(a) * R * (v / 10)];
  };
  const rings = [2, 4, 6, 8, 10].map((v) => `<polygon points="${DIMS.map((_, i) => pt(i, v).join(',')).join(' ')}" class="ring"/>`).join('');
  const axes = DIMS.map((_, i) => { const [x, y] = pt(i, 10); return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="axis"/>`; }).join('');
  const poly = DIMS.map(([k], i) => pt(i, scores[k]?.score ?? 0).join(',')).join(' ');
  const labels = DIMS.map(([k, label], i) => {
    const [x, y] = pt(i, 12.6);
    const anchor = Math.abs(x - cx) < 10 ? 'middle' : x > cx ? 'start' : 'end';
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="lbl">${esc(label)} <tspan class="num">${scores[k]?.score ?? '–'}</tspan></text>`;
  }).join('');
  return `<svg viewBox="-90 -10 500 320" role="img" aria-label="Radar chart of the five scores">${rings}${axes}<polygon points="${poly}" class="shape"/>${labels}</svg>`;
}

export function renderCritique(project, c) {
  const node = project.nodes.find((n) => n.id === c.nodeId);
  const scores = c.scores || {};
  const mean = DIMS.reduce((s, [k]) => s + (scores[k]?.score ?? 0), 0) / DIMS.length;
  const list = (items) => (items?.length ? `<ul>${items.map((t) => `<li><label><input type="checkbox"> <span>${esc(t)}</span></label></li>`).join('')}</ul>` : '<p class="muted">—</p>');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Critique · ${esc(node?.label || c.nodeId)}</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--ink:#16161a;--muted:#6b6b73;--line:#e3e3df;--accent:#ff5a1f;--good:#1f8a4c;--warn:#b7791f;--bad:#c53030}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--panel:#1b1b1f;--ink:#ededf0;--muted:#9a9aa3;--line:#2c2c33}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:40px 20px 80px}
header{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:28px;flex-wrap:wrap}
h1{font-size:28px;line-height:1.15;margin:0 0 6px;letter-spacing:-.01em}.muted{color:var(--muted)}
.verdict{font-size:17px;max-width:62ch;margin:0}.mean{font-size:44px;font-weight:650;letter-spacing:-.02em}.mean small{font-size:15px;color:var(--muted);font-weight:500}
.top{display:grid;grid-template-columns:minmax(0,360px) 1fr;gap:28px;align-items:start}
@media (max-width:760px){.top{grid-template-columns:1fr}}
svg{width:100%;height:auto}.ring{fill:none;stroke:var(--line)}.axis{stroke:var(--line)}.shape{fill:color-mix(in oklab,var(--accent) 22%,transparent);stroke:var(--accent);stroke-width:2}
.lbl{font-size:11px;fill:var(--muted)}.num{fill:var(--ink);font-weight:700}
.cards{display:grid;gap:12px}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card h3{margin:0;font-size:15px;display:flex;justify-content:space-between;gap:12px}.score{font-variant-numeric:tabular-nums}
.band{font-size:12px;font-weight:600;padding:2px 8px;border-radius:99px;margin-left:8px}
.Broken{background:color-mix(in oklab,var(--bad) 16%,transparent);color:var(--bad)}.Functional{background:color-mix(in oklab,var(--warn) 18%,transparent);color:var(--warn)}
.Strong,.Exceptional{background:color-mix(in oklab,var(--good) 16%,transparent);color:var(--good)}
.card p{margin:8px 0 0;color:var(--muted)}
.lists{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:32px}@media (max-width:760px){.lists{grid-template-columns:1fr}}
.lists section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
.lists h2{font-size:13px;text-transform:none;letter-spacing:.02em;margin:0 0 8px}
ul{margin:0;padding:0;list-style:none}li{padding:6px 0;border-top:1px solid var(--line)}li:first-child{border-top:0}
label{display:flex;gap:8px;align-items:flex-start;cursor:pointer}input{margin-top:5px;accent-color:var(--accent)}
.warn{margin-top:20px;padding:10px 14px;border-radius:8px;background:color-mix(in oklab,var(--warn) 14%,transparent);color:var(--ink)}
a{color:inherit}
</style></head><body><main>
<header><div><p class="muted">${esc(project.name)} · ${esc(node?.label || c.nodeId)} · ${esc(new Date(c.createdAt).toLocaleString())}</p>
<h1>Design critique</h1><p class="verdict">${esc(c.verdict || '')}</p></div>
<div class="mean">${mean.toFixed(1)}<small> / 10 mean</small></div></header>
<div class="top"><div>${radar(scores)}</div><div class="cards">
${DIMS.map(([k, label]) => { const s = scores[k] || {}; const b = band(s.score ?? 0); return `<div class="card"><h3><span>${esc(label)}</span><span class="score">${s.score ?? '–'}/10<span class="band ${b}">${b}</span></span></h3><p>${esc(s.evidence || '')}</p></div>`; }).join('\n')}
</div></div>
${mean > 8 ? '<p class="warn">Mean above 8 — the rubric treats this as suspicious grade inflation. Re-check the weakest dimension.</p>' : ''}
<div class="lists"><section><h2>Keep</h2>${list(c.keep)}</section><section><h2>Fix</h2>${list(c.fix)}</section><section><h2>Quick wins</h2>${list(c.quickWins)}</section></div>
<p class="muted" style="margin-top:28px"><a href="/p/${encodeURIComponent(project.slug)}#${esc(c.nodeId)}">← back to canvas</a></p>
</main></body></html>`;
}
