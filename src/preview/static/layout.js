// Pure canvas layout + edge geometry (no DOM).
export const GRID = 24;
export const snap = (v) => Math.round(v / GRID) * GRID;

export function computeLayout(nodes, edges, sizeOf, { gapX = 140, gapY = 220 } = {}) {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map();
  for (const n of nodes) {
    const p = n.parent && ids.has(n.parent) ? n.parent : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(n);
  }
  const widthMemo = new Map();
  const subtreeW = (n) => {
    if (widthMemo.has(n.id)) return widthMemo.get(n.id);
    const ch = kids.get(n.id) || [];
    const cw = ch.reduce((s, c) => s + subtreeW(c), 0) + Math.max(0, ch.length - 1) * gapX;
    const w = Math.max(sizeOf(n).w, cw);
    widthMemo.set(n.id, w);
    return w;
  };
  const pos = {};
  const place = (n, x, y) => {
    const size = sizeOf(n);
    const at = n.pos ? { x: n.pos.x, y: n.pos.y } : { x, y };
    pos[n.id] = { ...at, ...size };
    let cx = at.x;
    for (const c of kids.get(n.id) || []) { place(c, cx, at.y + size.h + gapY); cx += subtreeW(c) + gapX; }
  };
  const roots = kids.get(null) || [];
  const rootIds = new Set(roots.map((r) => r.id));
  const navEdges = (edges || []).filter((e) => e.kind === 'nav' && ids.has(e.from) && rootIds.has(e.to) && e.from !== e.to);
  // Unpositioned roots that are the target of a nav edge wait for their source.
  const pending = new Set(navEdges.filter((e) => !byId(roots, e.to).pos).map((e) => e.to));
  let x = 0;
  for (const r of roots) if (!pending.has(r.id)) { place(r, x, 0); x += subtreeW(r) + gapX * 2; }
  for (let moved = true; moved && pending.size;) {
    moved = false;
    for (const e of navEdges) {
      const s = pos[e.from];
      if (!pending.has(e.to) || !s) continue;
      place(byId(roots, e.to), s.x + s.w + gapX * 2, s.y);
      pending.delete(e.to);
      moved = true;
    }
  }
  // Cycles / sources that never got placed: normal root placement.
  for (const r of roots) if (pending.has(r.id)) { place(r, x, 0); x += subtreeW(r) + gapX * 2; }
  return pos;
}

const byId = (list, id) => list.find((n) => n.id === id);

export function autoLayout(nodes, edges, sizeOf) {
  const gapX = 140; const gapY = 220;
  const ids = new Set(nodes.map((n) => n.id));
  const byCreated = (a, b) => (a.createdAt > b.createdAt) - (a.createdAt < b.createdAt);
  const rootOf = (n) => { const seen = new Set(); while (n.parent && ids.has(n.parent) && !seen.has(n.id)) { seen.add(n.id); n = byId(nodes, n.parent); } return n; };
  const roots = nodes.filter((n) => !n.parent || !ids.has(n.parent)).sort(byCreated);
  const rootIds = new Set(roots.map((r) => r.id));
  const links = [];
  for (const e of edges || []) {
    if (e.kind !== 'nav' || !ids.has(e.from) || !ids.has(e.to)) continue;
    const a = rootOf(byId(nodes, e.from)).id; const b = rootOf(byId(nodes, e.to)).id;
    if (a !== b && rootIds.has(a) && rootIds.has(b)) links.push([a, b]);
  }
  const linked = roots.filter((r) => links.some(([a, b]) => a === r.id || b === r.id));
  const unlinked = roots.filter((r) => !linked.includes(r));
  // Kahn's walk, ties by creation order; cycle leftovers appended.
  const indeg = new Map(linked.map((r) => [r.id, 0]));
  for (const [, b] of links) indeg.set(b, indeg.get(b) + 1);
  const order = [];
  const left = [...linked];
  while (left.length) {
    const i = left.findIndex((r) => indeg.get(r.id) === 0);
    const [r] = left.splice(i < 0 ? 0 : i, 1);
    order.push(r);
    for (const [a, b] of links) if (a === r.id) indeg.set(b, indeg.get(b) - 1);
  }
  const out = {};
  let x = 0;
  for (const root of [...order, ...unlinked]) {
    const col = nodes.filter((n) => rootOf(n).id === root.id)
      .sort((a, b) => (a === root ? -1 : b === root ? 1 : byCreated(a, b)));
    let y = 0; let w = 0;
    for (const n of col) {
      const s = sizeOf(n);
      out[n.id] = { x: snap(x), y: snap(y) };
      y += s.h + gapY; w = Math.max(w, s.w);
    }
    x += w + gapX * 2;
  }
  return out;
}

// Cubic Bezier from the side of `a` facing `b` to the facing side of `b`.
export function edgeGeometry(a, b) {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  let p0; let p3; let c1; let c2;
  if (Math.abs(dx) >= Math.abs(dy)) {
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
