// Minimap: frames as rectangles plus the visible area; click or drag to move the view there.
export function createMinimap(el, { getPositions, getView, setView }) {
  const W = el.width; const H = el.height; const PAD = 8;
  const dpr = devicePixelRatio || 1;
  el.width = W * dpr; el.height = H * dpr;
  el.style.width = `${W}px`; el.style.height = `${H}px`;
  const g = el.getContext('2d');
  let map = null; // world -> minimap { k, ox, oy }; frozen while dragging so the view does not chase itself

  function fit() {
    const v = getView();
    const rects = [...Object.values(getPositions()), { x: -v.x / v.s, y: -v.y / v.s, w: innerWidth / v.s, h: innerHeight / v.s }];
    const x1 = Math.min(...rects.map((r) => r.x)); const y1 = Math.min(...rects.map((r) => r.y));
    const x2 = Math.max(...rects.map((r) => r.x + r.w)); const y2 = Math.max(...rects.map((r) => r.y + r.h));
    const k = Math.min((W - PAD * 2) / (x2 - x1), (H - PAD * 2) / (y2 - y1));
    return { k, ox: PAD + ((W - PAD * 2) - (x2 - x1) * k) / 2 - x1 * k, oy: PAD + ((H - PAD * 2) - (y2 - y1) * k) / 2 - y1 * k };
  }

  function draw() {
    const m = map || fit();
    const v = getView();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(255, 255, 255, .28)';
    for (const r of Object.values(getPositions())) g.fillRect(r.x * m.k + m.ox, r.y * m.k + m.oy, Math.max(1, r.w * m.k), Math.max(1, r.h * m.k));
    g.strokeStyle = '#3b82f6'; g.lineWidth = 1.5;
    g.strokeRect(-v.x / v.s * m.k + m.ox, -v.y / v.s * m.k + m.oy, innerWidth / v.s * m.k, innerHeight / v.s * m.k);
  }

  function centreOn(e) {
    const r = el.getBoundingClientRect();
    const wx = (e.clientX - r.left - map.ox) / map.k; const wy = (e.clientY - r.top - map.oy) / map.k;
    const { s } = getView();
    setView({ s, x: innerWidth / 2 - wx * s, y: innerHeight / 2 - wy * s });
  }
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    map = fit();
    el.setPointerCapture(e.pointerId);
    centreOn(e);
  });
  el.addEventListener('pointermove', (e) => { if (map) centreOn(e); });
  const end = () => { map = null; draw(); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  return { draw };
}
