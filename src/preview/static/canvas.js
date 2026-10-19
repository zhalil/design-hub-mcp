// Design Hub canvas: infinite pan/zoom mat with live design frames laid out as iteration trees.
(() => {
  const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
  const VP = { mobile: { w: 390, h: 844 }, tablet: { w: 820, h: 1180 }, desktop: { w: 1440, h: 900 } };
  const GAP_X = 140;
  const GAP_Y = 220;
  const MAX_FULL_H = 6000;

  const $ = (s) => document.querySelector(s);
  const mat = $('#mat'); const world = $('#world'); const links = $('#links');
  const tools = $('#frame-tools'); const promptEl = $('#prompt');

  let project = null;
  let view = { x: 120, y: 160, s: 0.3 };
  let selectedId = null;
  let interactId = null;
  let pickId = null;
  let picked = null;            // { nodeId, element }
  let positions = {};           // nodeId -> {x,y,w,h}
  const frames = new Map();     // nodeId -> { el, iframe, src }
  const heights = {};           // nodeId -> content height reported by the frame
  const fullHeight = loadPref('fullHeight', {});
  let firstLoad = true;
  let knownNodes = new Set();

  function loadPref(k, d) { try { return JSON.parse(localStorage.getItem(`dh:${slug}:${k}`)) ?? d; } catch { return d; } }
  function savePref(k, v) { try { localStorage.setItem(`dh:${slug}:${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } }

  // ---------------- data ----------------
  async function api(path, opts = {}) {
    const res = await fetch(`/api/p/${encodeURIComponent(slug)}${path}`, {
      ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function refresh() {
    try { project = await api(''); } catch (e) { showToast(e.message); return; }
    document.title = `${project.name} · Design Hub`;
    $('#project-name').textContent = project.name;
    $('#design-system').textContent = project.designSystem ? `Design system: ${project.designSystem.title || project.designSystem.id}` : 'No design system yet';
    for (const b of document.querySelectorAll('.status button')) b.setAttribute('aria-checked', String(b.dataset.status === project.status));
    setListening(project.listening);
    const newOnes = project.nodes.filter((n) => !knownNodes.has(n.id));
    knownNodes = new Set(project.nodes.map((n) => n.id));
    if (selectedId && !knownNodes.has(selectedId)) selectedId = null;
    layoutAndRender();
    renderActivity();
    if (firstLoad) {
      firstLoad = false;
      const hashNode = location.hash.slice(1) || new URLSearchParams(location.search).get('node');
      if (hashNode && knownNodes.has(hashNode)) { select(hashNode); zoomTo([hashNode]); }
      else if (project.selected && knownNodes.has(project.selected)) { select(project.selected); fitAll(); }
      else fitAll();
      firstFit = false;
    } else if (newOnes.length) {
      for (const n of newOnes) flash(n.id);
      const offscreen = newOnes.filter((n) => !onScreen(n.id));
      if (offscreen.length) showToast(`${newOnes.length === 1 ? `New: ${newOnes[0].label}` : `${newOnes.length} new designs`}`, 'Show', () => zoomTo(newOnes.map((n) => n.id)));
    }
    updateComposer();
  }

  // ---------------- layout ----------------
  function sizeOf(n) {
    const vp = VP[n.viewport] || VP.desktop;
    const h = fullHeight[n.id] && heights[n.id] ? Math.min(Math.max(heights[n.id], vp.h), MAX_FULL_H) : vp.h;
    return { w: vp.w, h };
  }

  function computeLayout(nodes) {
    const kids = new Map();
    for (const n of nodes) {
      const p = n.parent && nodes.some((x) => x.id === n.parent) ? n.parent : null;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(n);
    }
    const widthMemo = new Map();
    const subtreeW = (n) => {
      if (widthMemo.has(n.id)) return widthMemo.get(n.id);
      const ch = kids.get(n.id) || [];
      const cw = ch.reduce((s, c) => s + subtreeW(c), 0) + Math.max(0, ch.length - 1) * GAP_X;
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
      for (const c of kids.get(n.id) || []) { place(c, cx, at.y + size.h + GAP_Y); cx += subtreeW(c) + GAP_X; }
    };
    let x = 0;
    for (const r of kids.get(null) || []) { place(r, x, 0); x += subtreeW(r) + GAP_X * 2; }
    return pos;
  }

  function layoutAndRender() {
    const nodes = project?.nodes || [];
    $('#empty').hidden = nodes.length > 0;
    positions = computeLayout(nodes);
    const working = new Set((project?.requests || []).filter((r) => r.status === 'claimed' && r.nodeId).map((r) => r.nodeId));
    // remove frames of deleted nodes
    for (const [id, f] of frames) if (!positions[id]) { f.el.remove(); frames.delete(id); }
    for (const n of nodes) {
      let f = frames.get(n.id);
      if (!f) { f = createFrame(n); frames.set(n.id, f); world.appendChild(f.el); }
      const p = positions[n.id];
      Object.assign(f.el.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` });
      const src = `/f/${encodeURIComponent(slug)}/${n.file}?hub=1&v=${n.mtime || 0}`;
      if (f.src !== src) { f.src = src; f.iframe.src = src; }
      f.name.textContent = n.label;
      f.meta.textContent = `${n.id} · ${n.viewport}${n.revision > 1 ? ` · rev ${n.revision}` : ''}`;
      f.chosen.hidden = project.selected !== n.id;
      f.chosen.textContent = project.status === 'ready' ? 'Ready' : 'Chosen';
      f.work.hidden = !working.has(n.id);
      f.el.classList.toggle('working', working.has(n.id));
      f.el.classList.toggle('selected', selectedId === n.id);
      f.el.classList.toggle('interact', interactId === n.id);
      f.el.classList.toggle('picking', pickId === n.id);
    }
    drawLinks(nodes);
    applyView();
  }

  function drawLinks(nodes) {
    const parts = [];
    for (const n of nodes) {
      if (!n.parent || !positions[n.parent] || !positions[n.id]) continue;
      const a = positions[n.parent]; const b = positions[n.id];
      const x1 = a.x + a.w / 2; const y1 = a.y + a.h; const x2 = b.x + b.w / 2; const y2 = b.y - 40 / view.s;
      const my = (y1 + y2) / 2;
      parts.push(`<path d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}"/><circle cx="${x1}" cy="${y1}" r="${4 / view.s}"/><circle cx="${x2}" cy="${y2}" r="${4 / view.s}"/>`);
    }
    links.innerHTML = parts.join('');
  }

  function createFrame(n) {
    const el = document.createElement('div');
    el.className = 'frame';
    el.dataset.id = n.id;
    el.innerHTML = `<div class="frame-label"><span class="name"></span><span class="meta"></span><span class="chosen" hidden></span><span class="working" hidden>Claude is working…</span></div>
      <div class="frame-body"><iframe title="" loading="lazy" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"></iframe><div class="shield"></div></div>`;
    const f = { el, iframe: el.querySelector('iframe'), name: el.querySelector('.name'), meta: el.querySelector('.meta'), chosen: el.querySelector('.chosen'), work: el.querySelector('.working'), src: '' };
    f.iframe.title = n.label;
    const shield = el.querySelector('.shield');
    shield.addEventListener('pointerdown', (e) => { if (e.button === 0 && !space) { select(n.id); startPan(e); } });
    shield.addEventListener('dblclick', () => setInteract(n.id));
    el.querySelector('.frame-label').addEventListener('pointerdown', (e) => startFrameDrag(e, n.id));
    el.querySelector('.frame-label').addEventListener('dblclick', () => renameNode(n.id));
    return f;
  }

  // ---------------- view: pan / zoom ----------------
  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
    document.documentElement.style.setProperty('--s', view.s);
    // dot grid every 24 world px, doubling when zoomed out so dots never turn into noise
    let g = 24 * view.s; while (g < 12) g *= 2;
    mat.style.backgroundSize = `${g}px ${g}px`;
    mat.style.backgroundPosition = `${view.x}px ${view.y}px`;
    $('#zoom-level').textContent = `${Math.round(view.s * 100)}%`;
    drawRulers();
    placeTools();
    if (project) drawLinksLight();
  }
  let linkTimer = null;
  function drawLinksLight() { clearTimeout(linkTimer); linkTimer = setTimeout(() => drawLinks(project.nodes), 60); }

  // Zoom eases toward a target instead of jumping. will-change is set only while animating:
  // a permanently promoted layer is rasterized once and then stretched, which blurs the frames.
  let anim = null; // { s, cx, cy } zoom around a screen point, or { s, x, y } fly to a view
  let raf = 0;
  const clampS = (s) => Math.min(2, Math.max(0.03, s));
  function animate(target) {
    anim = target;
    world.style.willChange = 'transform';
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function stopAnim() { anim = null; cancelAnimationFrame(raf); raf = 0; world.style.willChange = ''; }
  function tick() {
    raf = 0;
    if (!anim) return;
    const ls = Math.log(view.s); const lt = Math.log(anim.s);
    const anchored = anim.cx !== undefined;
    const done = Math.abs(lt - ls) < 0.003 && (anchored || Math.hypot(anim.x - view.x, anim.y - view.y) < 0.5);
    const s = done ? anim.s : Math.exp(ls + (lt - ls) * 0.25);
    if (anchored) { const k = s / view.s; view = { s, x: anim.cx - (anim.cx - view.x) * k, y: anim.cy - (anim.cy - view.y) * k }; }
    else view = done ? { s, x: anim.x, y: anim.y } : { s, x: view.x + (anim.x - view.x) * 0.25, y: view.y + (anim.y - view.y) * 0.25 };
    applyView();
    if (done) stopAnim(); else raf = requestAnimationFrame(tick);
  }

  function zoomAt(factor, cx, cy) {
    const from = anim?.cx !== undefined ? anim.s : view.s;
    animate({ s: clampS(from * factor), cx, cy });
  }

  function bbox(ids) {
    const list = ids.map((id) => positions[id]).filter(Boolean);
    if (!list.length) return null;
    const x1 = Math.min(...list.map((p) => p.x)); const y1 = Math.min(...list.map((p) => p.y - 40));
    const x2 = Math.max(...list.map((p) => p.x + p.w)); const y2 = Math.max(...list.map((p) => p.y + p.h));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  function zoomTo(ids, maxScale = 1) {
    const b = bbox(ids);
    if (!b) return;
    const pad = 70; const top = 110; const bottom = 170;
    const W = innerWidth - pad * 2; const H = innerHeight - top - bottom;
    const s = Math.min(maxScale, Math.max(0.03, Math.min(W / b.w, H / b.h)));
    const to = { s, x: pad + (W - b.w * s) / 2 - b.x * s, y: top + (H - b.h * s) / 2 - b.y * s };
    if (firstFit) { view = to; applyView(); } else animate(to);
  }
  let firstFit = true;
  const fitAll = () => zoomTo(Object.keys(positions), 0.6);
  function onScreen(id) {
    const p = positions[id]; if (!p) return true;
    const x = p.x * view.s + view.x; const y = p.y * view.s + view.y;
    return x < innerWidth && y < innerHeight && x + p.w * view.s > 0 && y + p.h * view.s > 0;
  }

  // A mouse notch is ~100px and a pinch step a few px: clamp so one notch is a ~20% step, not 2.7×.
  const wheelZoom = (deltaY, deltaMode, cx, cy) => {
    const d = Math.max(-20, Math.min(20, deltaY * (deltaMode === 1 ? 20 : 1)));
    zoomAt(Math.exp(-d * 0.01), cx, cy);
  };
  // Ctrl/⌘+wheel anywhere zooms the canvas, never the browser page.
  addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); wheelZoom(e.deltaY, e.deltaMode, e.clientX, e.clientY); }
  }, { passive: false });
  // Plain wheel zooms; Shift+wheel pans horizontally, Alt+wheel vertically.
  mat.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) return;
    if (!e.shiftKey && !e.altKey) { wheelZoom(e.deltaY, e.deltaMode, e.clientX, e.clientY); return; }
    if (anim) stopAnim();
    const k = e.deltaMode === 1 ? 20 : 1;
    // browsers turn Shift+wheel into deltaX, so take whichever axis moved
    const d = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * k;
    if (e.shiftKey) view.x -= d; else view.y -= d;
    applyView();
  }, { passive: false });

  let space = false;
  let panState = null;
  function startPan(e) {
    if (anim && anim.cx === undefined) stopAnim();
    panState = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, id: e.pointerId };
    mat.setPointerCapture?.(e.pointerId);
  }
  mat.addEventListener('pointerdown', (e) => {
    const bg = e.target === mat || e.target === world || e.target === links || e.target.closest?.('#links');
    if (e.button === 1 || (e.button === 0 && (space || bg))) {
      e.preventDefault();
      startPan(e);
      panState.background = bg;
    }
  });
  mat.addEventListener('pointermove', (e) => {
    if (!panState) return;
    const dx = e.clientX - panState.x; const dy = e.clientY - panState.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { panState.moved = true; mat.classList.add('panning'); }
    view.x = panState.vx + dx; view.y = panState.vy + dy;
    applyView();
  });
  const endPan = () => {
    if (!panState) return;
    if (panState.background && !panState.moved) { select(null); setInteract(null); setPick(null); }
    panState = null; mat.classList.remove('panning');
  };
  mat.addEventListener('pointerup', endPan);
  mat.addEventListener('pointercancel', endPan);

  function startFrameDrag(e, id) {
    if (e.button !== 0) return;
    e.stopPropagation();
    select(id);
    const p = positions[id];
    const start = { x: e.clientX, y: e.clientY, px: p.x, py: p.y };
    let moved = false;
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / view.s; const dy = (ev.clientY - start.y) / view.s;
      if (Math.abs(dx) + Math.abs(dy) > 4 / view.s) moved = true;
      const n = project.nodes.find((x) => x.id === id);
      n.pos = { x: Math.round(start.px + dx), y: Math.round(start.py + dy) };
      layoutAndRender();
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      const n = project.nodes.find((x) => x.id === id);
      if (moved && n?.pos) api(`/nodes/${id}`, { method: 'PATCH', body: n.pos }).catch((er) => showToast(er.message));
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }

  $('#zoom-in').onclick = () => zoomAt(1.25, innerWidth / 2, innerHeight / 2);
  $('#zoom-out').onclick = () => zoomAt(0.8, innerWidth / 2, innerHeight / 2);
  $('#zoom-level').onclick = fitAll;
  addEventListener('resize', () => applyView());

  // ---------------- rulers ----------------
  function drawRulers() {
    for (const axis of ['x', 'y']) {
      const c = $(`#ruler-${axis}`);
      const dpr = devicePixelRatio || 1;
      const len = axis === 'x' ? c.clientWidth : c.clientHeight;
      if (!len) continue;
      if (axis === 'x') { c.width = len * dpr; c.height = 22 * dpr; } else { c.width = 22 * dpr; c.height = len * dpr; }
      const g = c.getContext('2d');
      g.scale(dpr, dpr);
      g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--ruler-ink').trim() || '#fff';
      g.strokeStyle = g.fillStyle;
      g.font = '500 10px "Instrument Sans", system-ui, sans-serif';
      const off = axis === 'x' ? view.x - 22 : view.y - 22;
      const steps = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
      const step = steps.find((st) => st * view.s >= 60) || 10000;
      const minor = step / 5;
      const startW = Math.floor(-off / view.s / minor) * minor;
      g.lineWidth = 1;
      g.beginPath();
      for (let w = startW; ; w += minor) {
        const px = Math.round(w * view.s + off) + 0.5;
        if (px > len) break;
        const majorTick = Math.abs(w % step) < 1e-6;
        const t = majorTick ? 9 : 4;
        if (axis === 'x') { g.moveTo(px, 22); g.lineTo(px, 22 - t); } else { g.moveTo(22, px); g.lineTo(22 - t, px); }
        if (majorTick) {
          if (axis === 'x') g.fillText(String(w), px + 3, 10);
          else { g.save(); g.translate(10, px - 3); g.rotate(-Math.PI / 2); g.fillText(String(w), 0, 0); g.restore(); }
        }
      }
      g.stroke();
    }
  }

  // ---------------- selection & modes ----------------
  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    if (picked && picked.nodeId !== id) picked = null;
    for (const [fid, f] of frames) f.el.classList.toggle('selected', fid === id);
    placeTools();
    updateComposer();
  }

  function post(id, msg) { frames.get(id)?.iframe.contentWindow?.postMessage({ dh: true, ...msg }, '*'); }

  function setInteract(id) {
    if (interactId && interactId !== id) frames.get(interactId)?.el.classList.remove('interact');
    interactId = id;
    if (id) { setPick(null); frames.get(id)?.el.classList.add('interact'); select(id); }
    placeTools();
  }

  function setPick(id) {
    if (pickId && pickId !== id) { post(pickId, { type: 'pick', on: false }); frames.get(pickId)?.el.classList.remove('picking'); }
    pickId = id;
    if (id) { interactId = null; frames.get(id)?.el.classList.remove('interact'); frames.get(id)?.el.classList.add('picking'); post(id, { type: 'pick', on: true }); select(id); }
    placeTools();
  }

  addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.dh !== true || !m.node) return;
    if (m.type === 'height') {
      heights[m.node] = m.h;
      if (fullHeight[m.node]) layoutAndRender();
    } else if (m.type === 'picked') {
      picked = { nodeId: m.node, element: m.element };
      setPick(null);
      select(m.node);
      updateComposer();
      promptEl.focus();
    } else if (m.type === 'pick-cancel') {
      setPick(null);
    } else if (m.type === 'key' && m.key === 'Escape') {
      setInteract(null);
    } else if (m.type === 'wheel-zoom' || m.type === 'key-zoom') {
      // forwarded from inside a frame (interact/pick mode): map frame coordinates to the screen
      const f = frames.get(m.node);
      const r = f?.iframe.getBoundingClientRect();
      if (!r) return;
      if (m.type === 'key-zoom') keyZoom(m.key);
      else wheelZoom(m.deltaY, m.deltaMode, r.left + m.x * view.s, r.top + m.y * view.s);
    }
  });

  function placeTools() {
    const id = selectedId;
    const p = id && positions[id];
    const n = id && project?.nodes.find((x) => x.id === id);
    if (!p || !n) { tools.hidden = true; return; }
    tools.hidden = false;
    const x = p.x * view.s + view.x;
    const yTop = p.y * view.s + view.y - 30; // just above the frame label
    const narrow = innerWidth < 720;
    tools.style.left = `${narrow ? 10 : Math.max(30, Math.min(x, innerWidth - tools.offsetWidth - 12))}px`;
    tools.style.top = `${Math.max(tools.offsetHeight + (narrow ? 96 : 92), yTop)}px`;
    for (const b of tools.querySelectorAll('[data-vp]')) b.setAttribute('aria-checked', String(b.dataset.vp === n.viewport));
    tools.querySelector('[data-act="pick"]').setAttribute('aria-pressed', String(pickId === id));
    tools.querySelector('[data-act="interact"]').setAttribute('aria-pressed', String(interactId === id));
    tools.querySelector('[data-act="fit-height"]').setAttribute('aria-pressed', String(Boolean(fullHeight[id])));
    tools.querySelector('[data-act="favorite"]').setAttribute('aria-pressed', String(project.selected === id));
    tools.querySelector('[data-act="open"]').href = `/f/${encodeURIComponent(slug)}/${n.file}`;
  }

  tools.addEventListener('click', async (e) => {
    const b = e.target.closest('button,a');
    if (!b || !selectedId) return;
    const id = selectedId;
    if (b.dataset.vp) {
      const n = project.nodes.find((x) => x.id === id); n.viewport = b.dataset.vp;
      layoutAndRender();
      return api(`/nodes/${id}`, { method: 'PATCH', body: { viewport: b.dataset.vp } }).catch((er) => showToast(er.message));
    }
    const act = b.dataset.act;
    try {
      if (act === 'pick') setPick(pickId === id ? null : id);
      else if (act === 'interact') setInteract(interactId === id ? null : id);
      else if (act === 'fit-height') { fullHeight[id] = !fullHeight[id]; savePref('fullHeight', fullHeight); layoutAndRender(); }
      else if (act === 'duplicate') { const n = await api(`/nodes/${id}/duplicate`, { method: 'POST', body: {} }); await refresh(); select(n.id); }
      else if (act === 'favorite') { await api('/select', { method: 'POST', body: { nodeId: project.selected === id ? null : id } }); }
      else if (act === 'delete') {
        const n = project.nodes.find((x) => x.id === id);
        if (confirm(`Delete “${n.label}”? Its file moves to the project's .trash folder.`)) { await api(`/nodes/${id}`, { method: 'DELETE' }); select(null); }
      }
    } catch (er) { showToast(er.message); }
  });

  async function renameNode(id) {
    const n = project.nodes.find((x) => x.id === id);
    const label = prompt('Rename design', n.label);
    if (label && label !== n.label) await api(`/nodes/${id}`, { method: 'PATCH', body: { label } }).catch((e) => showToast(e.message));
  }

  // ---------------- status ----------------
  for (const b of document.querySelectorAll('.status button')) {
    b.onclick = () => api('/status', { method: 'POST', body: { status: b.dataset.status, nodeId: selectedId || project.selected || undefined } }).catch((e) => showToast(e.message));
  }

  // ---------------- composer ----------------
  function targetNode() { return project?.nodes.find((x) => x.id === selectedId) || null; }

  function updateComposer() {
    const n = targetNode();
    const chip = $('#target-chip');
    if (picked && n && picked.nodeId === n.id) {
      chip.innerHTML = `Change <b></b> in <b></b>`;
      chip.querySelectorAll('b')[0].textContent = picked.element.label;
      chip.querySelectorAll('b')[1].textContent = n.label;
      $('#clear-element').hidden = false;
      promptEl.placeholder = `What should change in ${picked.element.label}?`;
    } else if (n) {
      chip.innerHTML = 'Iterate on <b></b>';
      chip.querySelector('b').textContent = n.label;
      $('#clear-element').hidden = true;
      promptEl.placeholder = 'Describe a change — Claude makes it as a new version next to this one';
    } else {
      chip.innerHTML = '<b>New design</b> from the project brief';
      $('#clear-element').hidden = true;
      promptEl.placeholder = 'Describe a new design, or select a frame to iterate on it';
    }
    $('#send-variations').textContent = n ? 'variations' : 'directions';
  }
  $('#clear-element').onclick = () => { picked = null; updateComposer(); };
  $('#target-chip').addEventListener('mouseenter', () => { if (picked) post(picked.nodeId, { type: 'highlight', selector: picked.element.selector }); });
  $('#target-chip').addEventListener('mouseleave', () => { if (picked) post(picked.nodeId, { type: 'highlight', selector: null }); });

  promptEl.addEventListener('input', () => { promptEl.style.height = 'auto'; promptEl.style.height = `${promptEl.scrollHeight}px`; });
  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
  });

  function buildRequest(kind) {
    const n = targetNode();
    const text = promptEl.value.trim();
    if (kind === 'variations') return { type: 'variations', nodeId: n?.id || null, text, count: Number($('#var-count').value) };
    if (picked && n && picked.nodeId === n.id) return { type: 'element', nodeId: n.id, text, element: picked.element, viewport: n.viewport };
    return { type: 'iterate', nodeId: n?.id || null, text, viewport: n?.viewport || null };
  }

  async function sendRequest(kind) {
    const body = buildRequest(kind);
    if (!body.text && body.type !== 'variations') { promptEl.focus(); showToast('Describe the change first'); return; }
    try {
      await api('/requests', { method: 'POST', body });
      promptEl.value = ''; promptEl.style.height = 'auto';
      picked = null; updateComposer();
      const rn = project.runner || {};
      showToast(project.listening ? 'Sent — Claude is picking it up'
        : rn.enabled && rn.available ? (rn.running ? 'Queued — Claude Code takes it after the current run' : 'Sent — starting Claude Code')
          : 'Queued. Ask Claude to “check the design canvas” to pick it up');
    } catch (e) { showToast(e.message); }
  }
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendRequest('iterate'); });
  $('#send-variations').onclick = () => sendRequest('variations');

  $('#copy-prompt').onclick = async () => {
    const r = buildRequest('iterate');
    const n = targetNode();
    const lines = [`Use the design-hub MCP. Project "${slug}".`];
    if (n) lines.push(`Target: node ${n.id} "${n.label}" (${n.viewport}), file ${project.dir}/${n.file}.`);
    if (r.type === 'element') lines.push(`Element: ${r.element.selector} — "${r.element.text.slice(0, 80)}".`);
    lines.push(`Request: ${r.text || '(describe the change)'}`);
    lines.push(n ? `Save the result with design_write (project "${slug}", parent "${n.id}").` : `Save the result with design_write (project "${slug}").`);
    try { await navigator.clipboard.writeText(lines.join('\n')); showToast('Prompt copied'); }
    catch { window.prompt('Copy this prompt', lines.join('\n')); }
  };

  // ---------------- activity ----------------
  const TYPE_LABEL = { iterate: 'Iterate', element: 'Element change', variations: 'Variations', comment: 'Comment', pick: 'Chosen' };
  const STATUS_LABEL = { pending: 'Queued', claimed: 'Claude is working', done: 'Done', dismissed: 'Dismissed', failed: 'Not done' };

  function renderActivity() {
    const reqs = [...(project.requests || [])].reverse();
    const pending = reqs.filter((r) => r.status === 'pending').length;
    $('#pending-count').hidden = !pending; $('#pending-count').textContent = pending;
    const list = $('#requests');
    list.innerHTML = reqs.length ? '' : '<li class="muted">Requests you send from the canvas show up here, with Claude’s reply.</li>';
    for (const r of reqs.slice(0, 60)) {
      const li = document.createElement('li');
      const node = project.nodes.find((n) => n.id === r.nodeId);
      li.innerHTML = `<div class="req-head"><span class="req-type"></span><span class="badge ${r.status}"></span></div><p class="req-text"></p><p class="req-meta"></p>`;
      li.querySelector('.req-type').textContent = TYPE_LABEL[r.type] + (r.count ? ` ×${r.count}` : '');
      li.querySelector('.badge').textContent = STATUS_LABEL[r.status] || r.status;
      li.querySelector('.req-text').textContent = r.text || '—';
      const meta = li.querySelector('.req-meta');
      meta.append(node ? `on ${node.label}` : 'new design');
      if (r.element) meta.append(` · ${r.element.label}`);
      if (r.status === 'pending') {
        const b = document.createElement('button'); b.className = 'linkish'; b.textContent = 'Cancel';
        b.onclick = () => api(`/requests/${r.id}/dismiss`, { method: 'POST', body: {} }).catch((e) => showToast(e.message));
        meta.append(' · ', b);
      }
      if (r.status === 'failed' || r.status === 'dismissed') {
        const b = document.createElement('button'); b.className = 'linkish'; b.textContent = 'Retry';
        b.onclick = () => api(`/requests/${r.id}/retry`, { method: 'POST', body: {} }).then(() => showToast('Queued again')).catch((e) => showToast(e.message));
        meta.append(' · ', b);
      }
      if (r.claimedBy === 'runner') meta.append(' · background run');
      if (r.reply) { const p = document.createElement('p'); p.className = 'req-reply'; p.textContent = r.reply; li.append(p); }
      if (r.resultNodes?.length) {
        const p = document.createElement('p'); p.className = 'req-meta'; p.append('Result: ');
        r.resultNodes.forEach((id, i) => {
          const b = document.createElement('button'); b.className = 'linkish';
          b.textContent = project.nodes.find((n) => n.id === id)?.label || id;
          b.onclick = () => { select(id); zoomTo([id]); };
          if (i) p.append(', ');
          p.append(b);
        });
        li.append(p);
      }
      list.append(li);
    }
    const cl = $('#critiques');
    const crit = [...(project.critiques || [])].reverse();
    cl.innerHTML = crit.length ? '' : '<li class="muted">No critiques yet. Ask Claude to critique a design.</li>';
    for (const c of crit.slice(0, 30)) {
      const li = document.createElement('li');
      const dims = ['philosophy', 'hierarchy', 'detail', 'functionality', 'innovation'];
      const mean = dims.reduce((s, d) => s + (c.scores?.[d]?.score || 0), 0) / dims.length;
      const node = project.nodes.find((n) => n.id === c.nodeId);
      li.innerHTML = `<div class="req-head"><a target="_blank" rel="noopener"></a><span class="badge"></span></div><p class="req-meta"></p>`;
      const a = li.querySelector('a'); a.href = `/c/${encodeURIComponent(slug)}/${c.id}`; a.textContent = node ? node.label : c.nodeId;
      li.querySelector('.badge').textContent = `${mean.toFixed(1)} / 10`;
      li.querySelector('.req-meta').textContent = c.verdict || '';
      cl.append(li);
    }
    const ds = $('#ds-info');
    ds.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = project.designSystem ? `${project.designSystem.title || project.designSystem.id}${project.designSystem.source ? ` (from ${project.designSystem.source})` : ''}` : 'No DESIGN.md yet. Claude sets one while choosing a direction.';
    ds.append(p);
    const b = document.createElement('button'); b.className = 'ghost'; b.textContent = 'View DESIGN.md';
    b.onclick = async () => { const d = await api('/design-md'); $('#md-text').textContent = d.exists ? d.text : 'No DESIGN.md in this project yet.'; $('#md-dialog').showModal(); };
    ds.append(b);
  }

  $('#toggle-activity').onclick = () => {
    const a = $('#activity'); a.hidden = !a.hidden;
    $('#toggle-activity').setAttribute('aria-expanded', String(!a.hidden));
    savePref('activity', !a.hidden);
  };
  if (loadPref('activity', false)) { $('#activity').hidden = false; $('#toggle-activity').setAttribute('aria-expanded', 'true'); }

  // Who will handle a request: the interactive Claude Code session (listening), a background
  // Claude Code run (claude -p under the user's subscription), or nobody yet.
  function setListening(on) {
    if (project) project.listening = Boolean(on);
    const rn = project?.runner || {};
    const working = (project?.requests || []).filter((r) => r.status === 'claimed').length;
    const el = $('#listening');
    let txt; let tip; let live = true;
    if (on) { txt = 'Claude is listening'; tip = 'Your Claude Code session picks requests up right away.'; }
    else if (rn.running) { txt = 'Claude Code is working'; tip = 'A background Claude Code run (your subscription) is handling your requests. Open Activity to follow it.'; }
    else if (working) { txt = `Claude is working on ${working === 1 ? 'your request' : `${working} requests`}`; tip = 'New requests are queued and picked up when Claude finishes.'; }
    else if (rn.enabled && rn.available) { txt = 'Claude Code on call'; tip = `Requests start a background Claude Code run with your subscription (${rn.claude || 'claude'}). No API key is used.`; }
    else { live = false; txt = 'Claude isn’t listening'; tip = rn.available === false ? (rn.error || 'Claude Code CLI not found.') : 'Background runs are off. Ask Claude in your session to check the design canvas, or turn on “Run Claude Code automatically” in Activity.'; }
    el.classList.toggle('on', live);
    el.querySelector('.txt').textContent = txt;
    el.title = tip;
    renderRunner();
  }

  function renderRunner() {
    const box = $('#runner');
    if (!box || !project) return;
    const rn = project.runner || {};
    const toggle = $('#runner-enabled');
    toggle.checked = Boolean(rn.enabled);
    toggle.disabled = rn.available === false;
    $('#runner-note').textContent = rn.available === false ? (rn.error || 'Claude Code CLI not found.')
      : `Uses the Claude Code CLI${rn.claude ? ` ${rn.claude.replace(/\s*\(Claude Code\)/, '')}` : ''} with your subscription login. No API key.`;
    const run = rn.running || rn.last;
    const logEl = $('#runner-log');
    $('#runner-stop').hidden = !rn.running;
    $('#runner-title').textContent = rn.running ? 'Claude Code is working…' : rn.last ? `Last run ${rn.last.stopped ? 'stopped' : rn.last.result?.ok ? 'finished' : 'ended'}` : 'No background runs yet';
    logEl.innerHTML = '';
    for (const l of (run?.log || []).slice(-14)) {
      const li = document.createElement('li');
      li.textContent = l.line;
      if (l.line.startsWith('→')) li.className = 'tool';
      logEl.append(li);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }
  $('#runner-enabled').addEventListener('change', async (e) => {
    try { await fetch('/api/runner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) }); await refresh(); }
    catch (er) { showToast(er.message); }
  });
  $('#runner-stop').onclick = () => api('/runner/stop', { method: 'POST', body: {} }).then(() => showToast('Stopping Claude Code…')).catch((e) => showToast(e.message));

  // ---------------- keyboard ----------------
  const typing = () => ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName);
  // Ctrl/⌘ + / − / 0 zoom the canvas instead of the browser page, even while typing.
  function keyZoom(key) {
    if (key === '+' || key === '=') zoomAt(1.25, innerWidth / 2, innerHeight / 2);
    else if (key === '-') zoomAt(0.8, innerWidth / 2, innerHeight / 2);
    else if (key === '0') fitAll();
  }
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '0'].includes(e.key)) { e.preventDefault(); keyZoom(e.key); return; }
    if (e.code === 'Space' && !typing()) { space = true; mat.classList.add('space'); if (!e.repeat) e.preventDefault(); }
    if (typing()) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if (e.key === 'Escape') { if (pickId) setPick(null); else if (interactId) setInteract(null); else if (picked) { picked = null; updateComposer(); } else select(null); }
    else if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) fitAll();
    else if (e.key === '@' || (e.shiftKey && e.code === 'Digit2')) { if (selectedId) zoomTo([selectedId]); }
    else if (e.key === '+' || e.key === '=' || e.key === '-') keyZoom(e.key);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) tools.querySelector('[data-act="delete"]').click();
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && selectedId) { e.preventDefault(); tools.querySelector('[data-act="duplicate"]').click(); }
    else if (e.key.toLowerCase() === 'e' && selectedId) setPick(pickId ? null : selectedId);
    else if (e.key.toLowerCase() === 'i' || e.key === 'Enter') { e.preventDefault(); promptEl.focus(); }
  });
  addEventListener('keyup', (e) => { if (e.code === 'Space') { space = false; mat.classList.remove('space'); } });

  // ---------------- toast ----------------
  let toastTimer = null;
  function showToast(text, actionLabel, action) {
    const t = $('#toast');
    t.innerHTML = '';
    t.append(text);
    if (actionLabel) { const b = document.createElement('button'); b.textContent = actionLabel; b.onclick = () => { action(); t.classList.remove('show'); }; t.append(b); }
    t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), actionLabel ? 6000 : 2600);
  }
  function flash(id) {
    const f = frames.get(id); if (!f) return;
    f.el.classList.remove('flash'); void f.el.offsetWidth; f.el.classList.add('flash');
  }

  // ---------------- live updates ----------------
  let refreshTimer = null;
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 120); };
  function connect() {
    const es = new EventSource(`/events?slug=${encodeURIComponent(slug)}`);
    es.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'listening') setListening(m.listening);
      else if (m.type === 'change') scheduleRefresh();
    };
    es.onerror = () => { setListening(false); $('#listening .txt').textContent = 'Preview server offline'; };
    es.onopen = () => scheduleRefresh();
  }

  refresh().then(connect);
})();
