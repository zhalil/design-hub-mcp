// Pure canvas layout + edge geometry (no DOM).
export const GRID = 24;
export const snap = (v) => Math.round(v / GRID) * GRID;

// The flow runs top to bottom and branches: a page sits centered above the pages it links to,
// which stand side by side. A page and its iterations share one row, iterations to its right.
// Frames with a saved pos stay put (unless ignorePos); what follows them is placed relative to them.
export function computeLayout(nodes, edges, sizeOf, { gapX = 140, gapY = 220, ignorePos = false } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rootOf = (n) => { const seen = new Set(); while (n.parent && byId.has(n.parent) && !seen.has(n.id)) { seen.add(n.id); n = byId.get(n.parent); } return n.id; };
  const rows = new Map();
  for (const n of nodes) { const r = rootOf(n); if (!rows.has(r)) rows.set(r, []); rows.get(r)[n.id === r ? 'unshift' : 'push'](n); }
  const rowW = (r) => rows.get(r).reduce((s, n) => s + sizeOf(n).w, 0) + (rows.get(r).length - 1) * gapX;
  const rowH = (r) => Math.max(...rows.get(r).map((n) => sizeOf(n).h));
  const links = [];
  for (const e of edges || []) {
    if (e.kind !== 'nav' || !byId.has(e.from) || !byId.has(e.to)) continue;
    const a = rootOf(byId.get(e.from)); const b = rootOf(byId.get(e.to));
    if (a !== b) links.push([a, b]);
  }
  // Depth-first from pages nothing links to drops links back into the current path, so cycles still lay out.
  const byCreated = (a, b) => { const x = byId.get(a).createdAt; const y = byId.get(b).createdAt; return (x > y) - (x < y); };
  const order = [...rows.keys()].sort(byCreated);
  const linked = order.filter((r) => links.some(([a, b]) => a === r || b === r));
  const dag = [];
  const state = new Map(); // 1 on the path, 2 done
  const visit = (r) => {
    state.set(r, 1);
    for (const [a, b] of links) if (a === r && state.get(b) !== 1) { dag.push([a, b]); if (!state.has(b)) visit(b); }
    state.set(r, 2);
  };
  for (const r of linked) if (!links.some(([, b]) => b === r)) visit(r);
  for (const r of linked) if (!state.has(r)) visit(r); // pure cycles
  // A page sits one level below the deepest page linking to it, under that page's branch.
  const level = new Map();
  const levelOf = (r) => {
    if (!level.has(r)) level.set(r, Math.max(-1, ...dag.filter(([, b]) => b === r).map(([a]) => levelOf(a))) + 1);
    return level.get(r);
  };
  const kids = new Map(order.map((r) => [r, []]));
  for (const r of order) {
    const from = dag.filter(([, b]) => b === r).map(([a]) => a);
    if (from.length) kids.get(from.reduce((p, a) => (levelOf(a) > levelOf(p) ? a : p))).push(r);
  }
  const forest = [...linked, ...order.filter((r) => !linked.includes(r))].filter((r) => !dag.some(([, b]) => b === r));
  const levelY = [0];
  for (const r of order) { const l = levelOf(r); levelY[l + 1] = Math.max(levelY[l + 1] || 0, rowH(r)); }
  for (let l = 1; l < levelY.length; l++) levelY[l] = levelY[l - 1] + levelY[l] + gapY;
  const memo = new Map();
  const span = (list) => list.reduce((s, c) => s + treeW(c), 0) + Math.max(0, list.length - 1) * gapX;
  const treeW = (r) => { if (!memo.has(r)) memo.set(r, Math.max(rowW(r), span(kids.get(r)))); return memo.get(r); };
  const pos = {};
  // x is the left edge of the slot this page's whole branch gets
  const place = (r, x, y) => {
    const head = rows.get(r)[0];
    const at = !ignorePos && head.pos ? { x: head.pos.x, y: head.pos.y } : { x: x + (treeW(r) - rowW(r)) / 2, y };
    let cx = at.x;
    for (const n of rows.get(r)) {
      const size = sizeOf(n);
      const p = n === head ? at : (!ignorePos && n.pos) || { x: cx, y: at.y };
      pos[n.id] = { x: p.x, y: p.y, ...size };
      cx += size.w + gapX;
    }
    let kx = at.x + rowW(r) / 2 - span(kids.get(r)) / 2;
    for (const c of kids.get(r)) { place(c, kx, at.y + levelY[levelOf(c)] - levelY[levelOf(r)]); kx += treeW(c) + gapX; }
  };
  let x = 0;
  for (const r of forest) { place(r, x, 0); x += treeW(r) + gapX * 2; }
  return pos;
}

/** "Auto layout" button: the same tree with saved positions ignored, snapped to the grid. */
export function autoLayout(nodes, edges, sizeOf) {
  const pos = computeLayout(nodes, edges, sizeOf, { ignorePos: true });
  return Object.fromEntries(Object.entries(pos).map(([id, p]) => [id, { x: snap(p.x), y: snap(p.y) }]));
}

// Cubic Bezier from the side of `a` facing `b` to the facing side of `b`: left/right within a row, top/bottom between rows.
export function edgeGeometry(a, b) {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  let p0; let p3; let c1; let c2;
  if (b.y < a.y + a.h && a.y < b.y + b.h) {
    const right = dx >= 0;
    p0 = [right ? a.x + a.w : a.x, a.y + a.h / 2];
    p3 = [right ? b.x : b.x + b.w, b.y + b.h / 2];
    const k = Math.max(40, Math.abs(p3[0] - p0[0]) / 2) * (right ? 1 : -1);
    c1 = [p0[0] + k, p0[1]]; c2 = [p3[0] - k, p3[1]];
  } else {
    const down = dy >= 0;
    p0 = [a.x + a.w / 2, down ? a.y + a.h : a.y];
    p3 = [b.x + b.w / 2, down ? b.y : b.y + b.h];
    const k = Math.max(40, Math.abs(p3[1] - p0[1]) / 2) * (down ? 1 : -1);
    c1 = [p0[0], p0[1] + k]; c2 = [p3[0], p3[1] - k];
  }
  const mid = (i) => (p0[i] + 3 * c1[i] + 3 * c2[i] + p3[i]) / 8;
  return { d: `M${p0} C${c1} ${c2} ${p3}`, lx: mid(0), ly: mid(1) };
}
