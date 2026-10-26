// Pure canvas layout + edge geometry (no DOM).
export const GRID = 24;
export const snap = (v) => Math.round(v / GRID) * GRID;

// A page's section is its root's: iterations follow their page.
const rootOf = (byId, n) => { const seen = new Set(); while (n.parent && byId.has(n.parent) && !seen.has(n.id)) { seen.add(n.id); n = byId.get(n.parent); } return n; };

// The flow runs top to bottom and branches: a page sits centered above the pages it links to,
// which stand side by side. A page and its iterations share one row, iterations to its right;
// an iteration a link points to is a page of its own and gets its own row under the linking page.
// A section (User, Orders…) is laid out as its own flow and then stands in the main flow as one
// framed block, under the page that links into it (or under another section if only that one does).
// Frames with a saved pos stay put (unless ignorePos); what follows them is placed relative to them.
export function computeLayout(nodes, edges, sizeOf, { gapX = 140, gapY = 220, ignorePos = false } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const navTo = new Set((edges || []).filter((e) => e.kind === 'nav' && byId.has(e.from)).map((e) => e.to));
  const rowOf = (n) => { const seen = new Set(); while (n.parent && byId.has(n.parent) && !navTo.has(n.id) && !seen.has(n.id)) { seen.add(n.id); n = byId.get(n.parent); } return n; };
  const rows = new Map();
  for (const n of nodes) { const r = rowOf(n).id; if (!rows.has(r)) rows.set(r, []); rows.get(r)[n.id === r ? 'unshift' : 'push'](n); }
  const blocks = new Map(); // '§User' -> the User section's flow, with room around it for its frame and title
  const rowW = (r) => (blocks.has(r) ? blocks.get(r).w + 2 * gapX : rows.get(r).reduce((s, n) => s + sizeOf(n).w, 0) + (rows.get(r).length - 1) * gapX);
  const rowH = (r) => (blocks.has(r) ? blocks.get(r).h + 3 * gapY : Math.max(...rows.get(r).map((n) => sizeOf(n).h)));
  const sectionOf = (r) => rootOf(byId, byId.get(r)).section || '';
  const links = [];
  for (const e of edges || []) {
    if (e.kind !== 'nav' || !byId.has(e.from) || !byId.has(e.to)) continue;
    const a = rowOf(byId.get(e.from)).id; const b = rowOf(byId.get(e.to)).id;
    if (a !== b) links.push([a, b]);
  }
  const created = (r) => byId.get(blocks.get(r)?.first ?? r).createdAt;
  const byCreated = (a, b) => { const x = created(a); const y = created(b); return (x > y) - (x < y); };
  const pos = {};

  // Measures one group of rows as a flow; place(x0, y0) then lays it out from that corner.
  const flow = (order, own) => {
    const linked = order.filter((r) => own.some(([a, b]) => a === r || b === r));
    // Depth-first from pages nothing links to drops links back into the current path, so cycles still lay out.
    const dag = [];
    const state = new Map(); // 1 on the path, 2 done
    const visit = (r) => {
      state.set(r, 1);
      for (const [a, b] of own) if (a === r && state.get(b) !== 1) { dag.push([a, b]); if (!state.has(b)) visit(b); }
      state.set(r, 2);
    };
    for (const r of linked) if (!own.some(([, b]) => b === r)) visit(r);
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
    // x is the left edge of the slot this page's whole branch gets
    const place = (r, x, y) => {
      const head = rows.get(r)?.[0];
      const at = !ignorePos && head?.pos ? { x: head.pos.x, y: head.pos.y } : { x: x + (treeW(r) - rowW(r)) / 2, y };
      if (blocks.has(r)) blocks.get(r).place(at.x + gapX, at.y + 2 * gapY);
      let cx = at.x;
      for (const n of rows.get(r) || []) {
        const size = sizeOf(n);
        const p = n === head ? at : (!ignorePos && n.pos) || { x: cx, y: at.y };
        pos[n.id] = { x: p.x, y: p.y, ...size };
        cx += size.w + gapX;
      }
      let kx = at.x + rowW(r) / 2 - span(kids.get(r)) / 2;
      for (const c of kids.get(r)) { place(c, kx, at.y + levelY[levelOf(c)] - levelY[levelOf(r)]); kx += treeW(c) + gapX; }
    };
    return {
      w: span(forest) + Math.max(0, forest.length - 1) * gapX,
      h: levelY[levelY.length - 1] - gapY,
      place: (x0, y0) => { let x = x0; for (const r of forest) { place(r, x, y0); x += treeW(r) + gapX * 2; } },
    };
  };

  const groups = new Map([['', []]]);
  for (const r of [...rows.keys()].sort(byCreated)) { const s = sectionOf(r); if (!groups.has(s)) groups.set(s, []); groups.get(s).push(r); }
  for (const [s, g] of groups) {
    if (s) blocks.set(`§${s}`, { ...flow(g, links.filter(([a, b]) => sectionOf(a) === s && sectionOf(b) === s)), first: g[0] });
  }
  // The main flow: its own links, links into a section, and section-to-section links into a section no main page enters.
  const main = links.filter(([a]) => !sectionOf(a)).map(([a, b]) => [a, sectionOf(b) ? `§${sectionOf(b)}` : b]);
  const entered = new Set(main.map(([, b]) => b));
  for (const [a, b] of links) {
    const x = sectionOf(a); const y = sectionOf(b);
    if (x && y && x !== y && !entered.has(`§${y}`)) main.push([`§${x}`, `§${y}`]);
  }
  flow([...groups.get(''), ...blocks.keys()].sort(byCreated), main).place(0, 0);
  // A moved frame never lies on an auto-placed one: those step aside.
  if (!ignorePos) for (const [id, p] of Object.entries(pushApart(pos, nodes.filter((n) => n.pos).map((n) => n.id)))) Object.assign(pos[id], p);
  return pos;
}

/** Moves boxes out of the way of the `fixed` ones, and whatever those bump into in turn, by the shorter way out. */
export function pushApart(rects, fixed, gap = 48) {
  const r = Object.fromEntries(Object.entries(rects).map(([id, b]) => [id, { ...b }]));
  const queue = fixed.filter((id) => r[id]);
  const pushed = new Set();
  for (let i = 0; i < queue.length && i < 500; i++) { // ponytail: capped, boxes pushed from opposite sides at once may still touch
    const a = r[queue[i]];
    for (const [id, b] of Object.entries(r)) {
      if (id === queue[i] || fixed.includes(id)) continue;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + gap;
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + gap;
      if (ox <= 0 || oy <= 0) continue;
      if (ox < oy) b.x += (b.x + b.w / 2 >= a.x + a.w / 2 ? ox : -ox);
      else b.y += (b.y + b.h / 2 >= a.y + a.h / 2 ? oy : -oy);
      pushed.add(id); queue.push(id);
    }
  }
  return Object.fromEntries([...pushed].map((id) => [id, { x: r[id].x, y: r[id].y }]));
}

/** The box around each section's frames, for its outline and title on the canvas. */
export function sectionBoxes(nodes, positions, pad = 0) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const boxes = new Map();
  for (const n of nodes) {
    const s = rootOf(byId, n).section; const p = positions[n.id];
    if (!s || !p) continue;
    const b = boxes.get(s) || { section: s, x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    boxes.set(s, { ...b, x1: Math.min(b.x1, p.x), y1: Math.min(b.y1, p.y), x2: Math.max(b.x2, p.x + p.w), y2: Math.max(b.y2, p.y + p.h) });
  }
  return [...boxes.values()].map(({ section, x1, y1, x2, y2 }) => ({ section, x: x1 - pad, y: y1 - pad, w: x2 - x1 + 2 * pad, h: y2 - y1 + 2 * pad }));
}

/** "Auto layout" button: the same tree with saved positions ignored, snapped to the grid. */
export function autoLayout(nodes, edges, sizeOf) {
  const pos = computeLayout(nodes, edges, sizeOf, { ignorePos: true });
  return Object.fromEntries(Object.entries(pos).map(([id, p]) => [id, { x: snap(p.x), y: snap(p.y) }]));
}

// Cubic Bezier in world coordinates, so a link stays glued to its frames while zooming.
// To a lower row: out of the bottom of `a`, into the top of `b`. Otherwise top to top, arcing above both,
// high enough for its pill to clear the frame titles. `a`/`b` may be zero-width ports on a frame's edge.
// The pill (lx, ly) sits at the top of an arc, or near the source of a downward link: clear of the titles below.
export function edgeGeometry(a, b) {
  let p0; let c1; let c2; let p3; let t = 0.5;
  if (b.y >= a.y + a.h) {
    t = 0.3;
    p0 = [a.x + a.w / 2, a.y + a.h]; p3 = [b.x + b.w / 2, b.y];
    const k = Math.max(80, (p3[1] - p0[1]) / 2);
    c1 = [p0[0], p0[1] + k]; c2 = [p3[0], p3[1] - k];
  } else {
    p0 = [a.x + a.w / 2, a.y]; p3 = [b.x + b.w / 2, b.y];
    const top = Math.min(p0[1], p3[1]) - Math.max(160, Math.abs(p3[0] - p0[0]) / 4);
    c1 = [p0[0], top]; c2 = [p3[0], top];
  }
  const at = (i) => (1 - t) ** 3 * p0[i] + 3 * (1 - t) ** 2 * t * c1[i] + 3 * (1 - t) * t ** 2 * c2[i] + t ** 3 * p3[i];
  return { d: `M${p0} C${c1} ${c2} ${p3}`, lx: at(0), ly: at(1) };
}

/** Spreads the links meeting one side of a frame along it, ordered by where their other end is, so they never
 *  share a point. Returns edge id -> { a, b }: the zero-width boxes edgeGeometry draws between. */
export function edgePorts(edges, positions) {
  const sides = new Map(); // 'n3:top' -> [{ e, end, other }]
  const ends = new Map();
  for (const e of edges) {
    const a = positions[e.from]; const b = positions[e.to];
    const down = b.y >= a.y + a.h;
    ends.set(e.id, { a: { ...a }, b: { ...b } });
    for (const [end, id, side, other] of [['a', e.from, down ? 'bottom' : 'top', b], ['b', e.to, 'top', a]]) {
      const k = `${id}:${side}`;
      if (!sides.has(k)) sides.set(k, []);
      sides.get(k).push({ e, end, ox: other.x + other.w / 2, side });
    }
  }
  for (const [k, list] of sides) {
    const box = positions[k.slice(0, k.lastIndexOf(':'))];
    list.sort((p, q) => p.ox - q.ox);
    // the frame title takes the left 70% of the top edge
    const [lo, hi] = list[0].side === 'top' ? [0.75, 0.95] : [0.1, 0.9];
    list.forEach((p, i) => {
      const t = list.length === 1 ? (list[0].side === 'top' ? lo : 0.5) : lo + ((hi - lo) * i) / (list.length - 1);
      Object.assign(ends.get(p.e.id)[p.end], { x: box.x + box.w * t, w: 0 });
    });
  }
  return ends;
}
