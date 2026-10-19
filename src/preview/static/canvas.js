// Design Hub canvas: infinite pan/zoom mat with live design frames laid out as iteration trees.
import { autoLayout, computeLayout, edgeGeometry, snap } from './layout.js';
import { createHistory } from './history.js';
import { createMinimap } from './minimap.js';

(() => {
  const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
  const VP = { mobile: { w: 390, h: 844 }, tablet: { w: 820, h: 1180 }, desktop: { w: 1440, h: 900 } };
  const GAP_X = 140;
  const GAP_Y = 220;
  const MAX_FULL_H = 6000;

  const $ = (s) => document.querySelector(s);
  const mat = $('#mat'); const world = $('#world'); const links = $('#links');
  const tools = $('#frame-tools'); const promptEl = $('#prompt'); const labelsEl = $('#edge-labels');

  let project = null;
  let view = { x: 120, y: 160, s: 0.3 };
  const selection = new Set();  // selected node and note ids
  const primary = () => (selection.size === 1 && positions[[...selection][0]] ? [...selection][0] : null);
  const history = createHistory();
  let tool = 'select';          // 'select' | 'hand' | 'note'
  let interactId = null;
  let pickId = null;
  let picked = null;            // { nodeId, element }
  let positions = {};           // nodeId -> {x,y,w,h}
  const frames = new Map();     // nodeId -> { el, iframe, src }
  const heights = {};           // nodeId -> content height reported by the frame
  const fullHeight = loadPref('fullHeight', {});
  let firstLoad = true;
  let knownNodes = new Set();
  let edgeSel = null;           // selected nav edge id (never together with a frame/note selection)
  let linkDrag = null;          // { from, x, y } while dragging a link handle, in world coords
  let editingEdge = null;       // edge id whose label is being edited inline
  let dragging = null;          // Map id -> pos while frames/notes are dragged: refresh() must not snap them back
  let band = null;              // { x, y, base, el } while a selection rectangle is dragged on empty mat
  const noteEls = new Map();    // noteId -> element
  const noteDrafts = new Map(); // noteId -> text typed here and not yet saved: refresh() keeps it over the server text
  const noteTimers = new Map(); // noteId -> idle-save timer
  const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink', 'gray'];

  function loadPref(k, d) { try { return JSON.parse(localStorage.getItem(`dh:${slug}:${k}`)) ?? d; } catch { return d; } }
  function savePref(k, v) { try { localStorage.setItem(`dh:${slug}:${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } }
  let mode = loadPref('mode', 'edit') === 'view' ? 'view' : 'edit';
  let linksFilter = loadPref('links', 'all');  // which connections to draw: 'all' | 'nav' | 'none'
  if (!['all', 'nav', 'none'].includes(linksFilter)) linksFilter = 'all';
  // View mode blocks changes to the canvas; returns true when the change may go ahead.
  function canEdit() {
    if (mode === 'edit') return true;
    showToast('View mode: switch to Edit to change the canvas');
    return false;
  }

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
    if (dragging) for (const n of [...project.nodes, ...project.notes]) if (dragging.has(n.id)) n.pos = dragging.get(n.id);
    for (const t of project.notes) if (noteDrafts.has(t.id)) t.text = noteDrafts.get(t.id);
    if (edgeSel && !project.edges.some((e) => e.id === edgeSel)) edgeSel = null;
    document.title = `${project.name} · Design Hub`;
    $('#project-name').textContent = project.name;
    $('#design-system').textContent = project.designSystem ? `Design system: ${project.designSystem.title || project.designSystem.id}` : 'No design system yet';
    for (const b of document.querySelectorAll('.status button')) b.setAttribute('aria-checked', String(b.dataset.status === project.status));
    setListening(project.listening);
    const newOnes = project.nodes.filter((n) => !knownNodes.has(n.id));
    knownNodes = new Set(project.nodes.map((n) => n.id));
    const noteIds = new Set((project.notes || []).map((n) => n.id));
    for (const id of selection) if (!knownNodes.has(id) && !noteIds.has(id)) selection.delete(id);
    layoutAndRender();
    renderActivity();
    renderLayers();
    const pinned = (project.notes || []).filter((n) => n.pinned).length;
    $('#pinned-count').textContent = pinned; $('#pinned-count').hidden = !pinned;
    renderPinned();
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

  function layoutAndRender() {
    const nodes = project?.nodes || [];
    $('#empty').hidden = nodes.length > 0;
    positions = computeLayout(nodes, project?.edges || [], sizeOf, { gapX: GAP_X, gapY: GAP_Y });
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
      f.el.classList.toggle('selected', selection.has(n.id));
      f.el.classList.toggle('interact', interactId === n.id);
      f.el.classList.toggle('picking', pickId === n.id);
    }
    renderNotes();
    drawLinks(nodes);
    applyView();
  }

  // ---------------- notes ----------------
  const note = (id) => project?.notes.find((t) => t.id === id);
  // Where a note sits: its pos, or (R2: Claude added it without a spot) a column under the Design Context note.
  function noteRect(t) {
    const pos = t.pos || { x: -420, y: 312 + project.notes.filter((x) => !x.pos).indexOf(t) * 224 };
    return { ...pos, w: t.size?.w || 280, h: t.size?.h || 200 };
  }

  function renderNotes() {
    const list = project?.notes || [];
    for (const [id, el] of noteEls) if (!note(id)) { el.remove(); noteEls.delete(id); noteDrafts.delete(id); }
    for (const t of list) {
      let el = noteEls.get(t.id);
      if (!el) { el = noteEl(t.id); noteEls.set(t.id, el); world.appendChild(el); }
      const r = noteRect(t);
      Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      el.className = `note note-${t.color}${t.pinned ? ' pinned' : ''}${selection.has(t.id) ? ' selected' : ''}`;
      el.querySelector('.pin').setAttribute('aria-pressed', String(t.pinned));
      const ta = el.querySelector('textarea');
      ta.readOnly = mode !== 'edit';
      if (ta !== document.activeElement && ta.value !== t.text) ta.value = t.text; // never under the caret
    }
  }

  function noteEl(id) {
    const el = document.createElement('div');
    el.dataset.id = id;
    el.innerHTML = `<div class="note-head"><button class="pin" title="Pin: send to Claude with every request" aria-label="Pin note">📌</button>
      <span class="dots">${NOTE_COLORS.map((c) => `<button class="note-${c}" data-color="${c}" title="${c}" aria-label="${c} note"></button>`).join('')}</span>
      <button class="del" title="Delete note" aria-label="Delete note">×</button></div><textarea aria-label="Note" placeholder="Write a note…"></textarea>`;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || space || tool === 'hand') return; // the mat pans
      if (e.target.closest('.note-head') && !e.target.closest('button')) { startDrag(e, id); return; }
      e.stopPropagation();
      if (e.shiftKey) toggleSelect(id); else select(id);
    });
    el.querySelector('.note-head').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !note(id) || !canEdit()) return;
      if (b.classList.contains('del')) deleteItems([id]);
      else patchNote(id, b.dataset.color ? { color: b.dataset.color } : { pinned: !note(id).pinned });
    });
    const ta = el.querySelector('textarea');
    ta.addEventListener('input', () => {
      noteDrafts.set(id, ta.value);
      if (note(id)) note(id).text = ta.value;
      clearTimeout(noteTimers.get(id)); noteTimers.set(id, setTimeout(() => saveNote(id), 600));
    });
    ta.addEventListener('blur', () => saveNote(id));
    return el;
  }

  function saveNote(id) {
    clearTimeout(noteTimers.get(id));
    const text = noteDrafts.get(id);
    if (text === undefined) return;
    api(`/notes/${id}`, { method: 'PATCH', body: { text } }).catch((e) => showToast(e.message)).finally(() => {
      // keep the draft while the user is still typing in it
      if (noteDrafts.get(id) === text && document.activeElement !== noteEls.get(id)?.querySelector('textarea')) noteDrafts.delete(id);
    });
  }

  const patchNote = (id, body) => api(`/notes/${id}`, { method: 'PATCH', body }).then(refresh, (e) => showToast(e.message));

  // Undo/redo re-create a deleted note under a new id; steps resolve the id they captured through this map.
  const noteAlias = new Map();
  const noteId = (id) => { while (noteAlias.has(id)) id = noteAlias.get(id); return id; };
  async function dropNote(id) { // deletes the note and returns it, to re-create it later
    const t = note(noteId(id));
    if (!t) throw new Error('That note no longer exists');
    await api(`/notes/${t.id}`, { method: 'DELETE' });
    return t;
  }
  async function reviveNote(t) {
    const { text, pinned, color, pos, size } = t;
    const n = await api('/notes', { method: 'POST', body: { text, pinned, color, pos, size } });
    noteAlias.set(t.id, n.id);
  }

  function addNote(pos) {
    if (!canEdit()) return;
    let id = null; let gone = null;
    undoable(async () => { ({ id } = await api('/notes', { method: 'POST', body: { text: '', pos } })); },
      { label: 'Add note', undo: async () => { gone = await dropNote(id); }, redo: () => reviveNote(gone) })
      .then(() => { if (id && note(id)) { select(id); noteEls.get(id)?.querySelector('textarea').focus(); } });
  }

  // Deletes frames and notes as one step. Undo restores frames (same id, file, edges) newest-deleted first,
  // so an edge between two deleted frames comes back with the second one, and re-creates notes.
  function deleteItems(ids) {
    if (!canEdit() || !ids.length) return;
    const frameIds = ids.filter((x) => positions[x]); const noteIds = ids.filter((x) => !positions[x] && note(x));
    const one = frameIds.length === 1 && !noteIds.length && project.nodes.find((n) => n.id === frameIds[0]);
    if (frameIds.length && !confirm(one ? `Delete “${one.label}”? Its file moves to the project's .trash folder.`
      : `Delete ${frameIds.length + noteIds.length} items? Design files move to the project's .trash folder.`)) return;
    let frames = []; let gone = []; // what the last drop actually deleted: undo and redo cover only that
    const drop = async (fIds, nIds) => {
      frames = []; gone = [];
      for (const id of fIds) { await api(`/nodes/${id}`, { method: 'DELETE' }); frames.push(id); }
      for (const id of nIds) gone.push(await dropNote(id));
    };
    const label = one ? 'Delete design' : frameIds.length + noteIds.length === 1 ? 'Delete note' : `Delete ${frameIds.length + noteIds.length} items`;
    const step = {
      label,
      undo: async () => {
        for (const id of [...frames].reverse()) await api(`/nodes/${id}/restore`, { method: 'POST', body: {} });
        for (const t of gone) await reviveNote(t);
      },
      redo: () => drop([...frames], gone.map((t) => t.id)),
    };
    undoable(async () => {
      try { await drop(frameIds, noteIds); } catch (e) { if (frames.length || gone.length) e.step = step; throw e; }
    }, step);
  }

  const pinPop = $('#pinned-pop');
  function renderPinned() {
    if (pinPop.hidden || !project) return;
    const list = $('#pinned-list');
    const pinned = project.notes.filter((t) => t.pinned);
    list.innerHTML = pinned.length ? '' : '<li class="muted">No pinned notes</li>';
    for (const t of pinned) {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.textContent = t.text.split('\n')[0] || 'Empty note';
      const b = document.createElement('button'); b.className = 'linkish'; b.textContent = 'Go to';
      b.onclick = () => { pinPop.hidden = true; select(t.id); zoomTo([t.id]); };
      li.append(name, b); list.append(li);
    }
  }
  addEventListener('pointerdown', (e) => { if (!pinPop.hidden && !e.target.closest('#pinned-pop, [data-act="pinned"]')) pinPop.hidden = true; }, true);

  function drawLinks(nodes) {
    const s = view.s;
    const parts = [`<defs><marker id="arrow" markerUnits="userSpaceOnUse" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${12 / s}" markerHeight="${12 / s}" orient="auto"><path d="M0,0L10,5L0,10z"/></marker></defs>`];
    if (linksFilter === 'all') {
      for (const n of nodes) {
        if (!n.parent || !positions[n.parent] || !positions[n.id]) continue;
        const a = positions[n.parent]; const b = positions[n.id];
        const x1 = a.x + a.w / 2; const y1 = a.y + a.h; const x2 = b.x + b.w / 2; const y2 = b.y - 40 / s;
        const my = (y1 + y2) / 2;
        parts.push(`<path class="lineage" d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}"/><circle cx="${x1}" cy="${y1}" r="${4 / s}"/><circle cx="${x2}" cy="${y2}" r="${4 / s}"/>`);
      }
    }
    const pills = [];
    const nav = linksFilter === 'none' ? [] : (project?.edges || []).filter((e) => e.kind === 'nav' && positions[e.from] && positions[e.to]);
    for (const e of nav) {
      const g = edgeGeometry(positions[e.from], positions[e.to]);
      parts.push(`<path class="nav${e.id === edgeSel ? ' selected' : ''}" data-id="${e.id}" d="${g.d}" marker-end="url(#arrow)"/><path class="edge-hit" data-id="${e.id}" d="${g.d}"/>`);
      if (e.label) pills.push({ e, g });
    }
    if (linkDrag && positions[linkDrag.from]) {
      parts.push(`<path class="temp" d="${edgeGeometry(positions[linkDrag.from], { x: linkDrag.x, y: linkDrag.y, w: 0, h: 0 }).d}" marker-end="url(#arrow)"/>`);
    }
    links.innerHTML = parts.join('');
    if (editingEdge) return; // leave the inline label editor alone
    labelsEl.replaceChildren(...pills.map(({ e, g }) => {
      const el = document.createElement('span');
      el.className = `edge-label${e.id === edgeSel ? ' selected' : ''}`;
      el.dataset.id = e.id; el.textContent = e.label;
      el.style.left = `${g.lx}px`; el.style.top = `${g.ly}px`;
      return el;
    }));
  }

  function createFrame(n) {
    const el = document.createElement('div');
    el.className = 'frame';
    el.dataset.id = n.id;
    el.innerHTML = `<div class="frame-label"><span class="name"></span><span class="meta"></span><span class="chosen" hidden></span><span class="working" hidden>Claude is working…</span></div>
      <div class="frame-body"><iframe title="" loading="lazy" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"></iframe><div class="shield"></div></div><div class="link-handle" title="Drag onto another design to link them"></div>`;
    const f = { el, iframe: el.querySelector('iframe'), name: el.querySelector('.name'), meta: el.querySelector('.meta'), chosen: el.querySelector('.chosen'), work: el.querySelector('.working'), src: '' };
    f.iframe.title = n.label;
    const shield = el.querySelector('.shield');
    shield.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || space || tool !== 'select') return;
      if (e.shiftKey) { e.stopPropagation(); toggleSelect(n.id); return; }
      select(n.id); startPan(e);
    });
    shield.addEventListener('dblclick', () => setInteract(n.id));
    el.querySelector('.frame-label').addEventListener('pointerdown', (e) => startDrag(e, n.id));
    el.querySelector('.frame-label').addEventListener('dblclick', () => renameNode(n.id));
    el.querySelector('.link-handle').addEventListener('pointerdown', (e) => startLinkDrag(e, n.id));
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
    minimap.draw();
    placeTools();
    if (project) drawLinksLight();
  }
  let linkTimer = null;
  function drawLinksLight() { clearTimeout(linkTimer); linkTimer = setTimeout(() => drawLinks(project.nodes), 60); }

  // Zoom eases toward a target instead of jumping. will-change is set only while animating:
  // a permanently promoted layer is rasterized once and then stretched, which blurs the frames.
  let anim = null; // { s, cx, cy } zoom around a screen point, or { s, x, y } fly to a view
  let raf = 0;
  const clampS = (s) => Math.min(3, Math.max(0.1, s));
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

  function rectOf(id) {
    const t = positions[id] ? null : note(id);
    return positions[id] || (t && noteRect(t));
  }
  // left edge of the Agent panel when it is open, else the window edge
  const rightEdge = () => ($('#agent').hidden ? innerWidth : $('#agent').getBoundingClientRect().left);
  function bbox(ids) {
    const list = ids.map(rectOf).filter(Boolean);
    if (!list.length) return null;
    const x1 = Math.min(...list.map((p) => p.x)); const y1 = Math.min(...list.map((p) => p.y - 40));
    const x2 = Math.max(...list.map((p) => p.x + p.w)); const y2 = Math.max(...list.map((p) => p.y + p.h));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  function zoomTo(ids, maxScale = 1) {
    const b = bbox(ids);
    if (!b) return;
    // keep clear of the left toolbar, the Layers and Agent panels and the top bars
    const left = $('#lefttools').getBoundingClientRect().right + 24; const right = innerWidth - rightEdge() + 40;
    const top = 140; const bottom = 40; // top leaves room for the frame toolbar above the labels
    const W = innerWidth - left - right; const H = innerHeight - top - bottom;
    const s = Math.min(maxScale, clampS(Math.min(W / b.w, H / b.h)));
    const to = { s, x: left + (W - b.w * s) / 2 - b.x * s, y: top + (H - b.h * s) / 2 - b.y * s };
    if (firstFit) { view = to; applyView(); } else animate(to);
  }
  let firstFit = true;
  const fitAll = () => zoomTo([...Object.keys(positions), ...(project?.notes || []).map((t) => t.id)], 0.6);
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
    if (tool === 'note' && e.button === 0 && !space) {
      e.preventDefault(); setTool('select');
      addNote({ x: snap((e.clientX - view.x) / view.s), y: snap((e.clientY - view.y) / view.s) });
      return;
    }
    const bg = e.target === mat || e.target === world || e.target === links || e.target.closest?.('#links');
    if (e.button === 0 && bg && tool === 'select' && !space) {
      e.preventDefault();
      band = { x: e.clientX, y: e.clientY, base: e.shiftKey ? [...selection] : [], el: null };
      mat.setPointerCapture?.(e.pointerId);
      return;
    }
    if (e.button === 1 || (e.button === 0 && (space || bg || tool === 'hand'))) {
      e.preventDefault();
      startPan(e);
      panState.background = bg;
    }
  });
  mat.addEventListener('pointermove', (e) => {
    if (band) { moveBand(e); return; }
    if (!panState) return;
    const dx = e.clientX - panState.x; const dy = e.clientY - panState.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { panState.moved = true; mat.classList.add('panning'); }
    view.x = panState.vx + dx; view.y = panState.vy + dy;
    applyView();
  });
  const endPan = () => {
    if (band) { endBand(); return; }
    if (!panState) return;
    if (panState.background && !panState.moved) { select(null); setInteract(null); setPick(null); }
    panState = null; mat.classList.remove('panning');
  };
  mat.addEventListener('pointerup', endPan);
  mat.addEventListener('pointercancel', endPan);

  // Rubber band: selects every frame and note it touches (Shift keeps the earlier selection).
  function moveBand(e) {
    const x1 = Math.min(band.x, e.clientX); const y1 = Math.min(band.y, e.clientY);
    const x2 = Math.max(band.x, e.clientX); const y2 = Math.max(band.y, e.clientY);
    if (!band.el) {
      if (x2 - x1 + y2 - y1 <= 3) return;
      band.el = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'band' }));
    }
    Object.assign(band.el.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
    const w = (x, y) => [(x - view.x) / view.s, (y - view.y) / view.s];
    const [wx1, wy1] = w(x1, y1); const [wx2, wy2] = w(x2, y2);
    const hits = [...Object.keys(positions), ...(project?.notes || []).map((t) => t.id)].filter((id) => {
      const r = rectOf(id); return r.x < wx2 && r.x + r.w > wx1 && r.y < wy2 && r.y + r.h > wy1;
    });
    setSelection([...new Set([...band.base, ...hits])]);
  }
  function endBand() {
    if (band.el) band.el.remove();
    else if (!band.base.length) { select(null); setInteract(null); setPick(null); } // a plain click on empty mat
    band = null;
  }

  // Dragging a frame label or note header moves the whole selection; the grabbed item snaps to the grid
  // and the others keep their offsets. One history step puts them all back.
  function startDrag(e, id) {
    if (e.button !== 0 || space || tool === 'hand') return; // the mat pans
    e.stopPropagation();
    if (e.shiftKey) { toggleSelect(id); return; }
    const inSelection = selection.has(id);
    if (!inSelection) select(id);
    if (mode !== 'edit') { startPan(e); return; }
    const from = new Map([...selection].filter(rectOf).map((x) => [x, { x: rectOf(x).x, y: rectOf(x).y }]));
    const isFrame = new Map([...from.keys()].map((x) => [x, Boolean(positions[x])]));
    const start = { x: e.clientX, y: e.clientY };
    const drag = new Map();
    dragging = drag;
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / view.s; const dy = (ev.clientY - start.y) / view.s;
      if (!drag.size && Math.abs(dx) + Math.abs(dy) <= 4 / view.s) return;
      const o = from.get(id);
      const sx = snap(o.x + dx) - o.x; const sy = snap(o.y + dy) - o.y;
      for (const [x, p] of from) {
        const pos = { x: p.x + sx, y: p.y + sy };
        drag.set(x, pos);
        const it = project.nodes.find((n) => n.id === x) || note(x);
        if (it) it.pos = pos;
      }
      layoutAndRender();
    };
    const up = (ev) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      const done = () => { if (dragging === drag) dragging = null; };
      const to = [...drag].map(([x, pos]) => ({ id: x, frame: isFrame.get(x), pos }));
      if (ev.type === 'pointercancel' || !to.length || (to[0].pos.x === from.get(to[0].id).x && to[0].pos.y === from.get(to[0].id).y)) {
        done();
        if (to.length) refresh(); // no PATCH: put everything back where the server has it
        else if (inSelection && ev.type !== 'pointercancel') select(id); // a click inside a multi-selection narrows it
        return;
      }
      const back = to.map((m) => ({ ...m, pos: from.get(m.id) }));
      const label = to.length > 1 ? `Move ${to.length} items` : to[0].frame ? 'Move design' : 'Move note';
      moveAll(to, back, label, done);
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  }
  // PATCHes every { id, frame, pos }; on failure the error carries `applied`, the ones that did move.
  async function moveItems(list) {
    const r = await Promise.allSettled(list.map(({ id, frame, pos }) => (frame
      ? api(`/nodes/${id}`, { method: 'PATCH', body: pos })
      : api(`/notes/${noteId(id)}`, { method: 'PATCH', body: { pos } }))));
    const failed = r.find((x) => x.status === 'rejected');
    if (failed) throw Object.assign(failed.reason, { applied: list.filter((_, i) => r[i].status === 'fulfilled') });
  }
  // One undoable move; if only some items moved, the step covers just those. `settle` runs before the refresh.
  function moveAll(to, back, label, settle = () => {}) {
    const stepFor = (list) => {
      const ids = new Set(list.map((m) => m.id)); const prev = back.filter((m) => ids.has(m.id));
      return { label, undo: () => moveItems(prev), redo: () => moveItems(list) };
    };
    return undoable(async () => {
      try { await moveItems(to); } catch (e) { if (e.applied?.length) e.step = stepFor(e.applied); throw e; } finally { settle(); }
    }, stepFor(to));
  }

  function arrange() {
    if (!project || !canEdit()) return;
    const next = autoLayout(project.nodes, project.edges, sizeOf);
    const to = []; const back = [];
    for (const [id, pos] of Object.entries(next)) {
      const p = positions[id];
      if (p && (p.x !== pos.x || p.y !== pos.y)) { to.push({ id, frame: true, pos }); back.push({ id, frame: true, pos: { x: p.x, y: p.y } }); }
    }
    if (!to.length) { showToast('Already laid out'); return; }
    moveAll(to, back, 'Auto layout');
  }

  // Drag from a frame's link handle; dropping on another frame links the two.
  function startLinkDrag(e, from) {
    if (e.button !== 0 || mode !== 'edit') return;
    e.stopPropagation(); e.preventDefault();
    const at = (ev) => ({ x: (ev.clientX - view.x) / view.s, y: (ev.clientY - view.y) / view.s });
    linkDrag = { from, ...at(e) };
    const move = (ev) => { Object.assign(linkDrag, at(ev)); drawLinks(project.nodes); };
    const up = (ev) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      const { x, y } = at(ev);
      linkDrag = null; drawLinks(project.nodes);
      if (ev.type === 'pointercancel') return;
      const to = Object.keys(positions).find((id) => { const r = positions[id]; return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; });
      if (to && to !== from) linkFrames(from, to);
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  }

  $('#fit-btn').onclick = fitAll;
  const filterEl = $('#links-filter');
  filterEl.value = linksFilter;
  filterEl.onchange = () => {
    linksFilter = filterEl.value; savePref('links', linksFilter); filterEl.blur();
    edgeSel = null; // a hidden edge must not stay deletable
    if (project) drawLinks(project.nodes);
  };
  const presets = $('#zoom-presets');
  const showPresets = (on) => { presets.hidden = !on; $('#zoom-menu').setAttribute('aria-expanded', String(on)); };
  $('#zoom-menu').onclick = () => showPresets(presets.hidden);
  presets.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    showPresets(false);
    animate({ s: clampS(parseInt(b.textContent, 10) / 100), cx: innerWidth / 2, cy: innerHeight / 2 });
  };
  addEventListener('pointerdown', (e) => { if (!presets.hidden && !e.target.closest('#viewbar .zoom')) showPresets(false); });
  addEventListener('resize', () => applyView());

  const minimap = createMinimap($('#minimap'), {
    getPositions: () => positions,
    getView: () => view,
    setView: (v) => { stopAnim(); view = v; applyView(); },
  });

  // ---------------- mode & tools ----------------
  function setMode(m) {
    mode = m; savePref('mode', m);
    document.body.dataset.mode = m;
    for (const b of $('#mode').children) b.setAttribute('aria-checked', String(b.dataset.mode === m));
    placeTools(); // Link is Edit-only
    renderNotes(); // note text is read-only in View mode
  }
  for (const b of $('#mode').children) b.onclick = () => setMode(b.dataset.mode);
  setMode(mode);

  function setTool(t) {
    tool = t;
    mat.classList.toggle('hand', t === 'hand');
    mat.classList.toggle('note-tool', t === 'note');
    for (const b of document.querySelectorAll('#lefttools [data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  }
  setTool('select');
  $('#lefttools').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
    else if (b.dataset.act === 'duplicate' && primary()) tools.querySelector('[data-act="duplicate"]').click();
    else if (b.dataset.act === 'autolayout') arrange();
    else if (b.dataset.act === 'pinned') { pinPop.hidden = !pinPop.hidden; renderPinned(); }
  });

  // Canvas changes and undo/redo run one at a time, in order: a fast Ctrl+Z waits for the change before it.
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn).catch((e) => showToast(e.message)));
  // The step is pushed as soon as the server took the change, before the refresh. A change that failed
  // part-way pushes the step it attached to the error (`e.step`, covering what was applied) and still refreshes.
  const undoable = (run, step) => serial(async () => {
    try { await run(); history.push(step); } catch (e) { if (e.step) history.push(e.step); throw e; } finally { await refresh(); }
  });
  function undoRedo(redo) {
    if (!canEdit()) return;
    serial(async () => {
      try {
        const label = await (redo ? history.redo() : history.undo());
        if (label) showToast(`${redo ? 'Redo' : 'Undo'}: ${label}`);
      } finally { await refresh(); }
    });
  }

  // ---------------- layers ----------------
  function renderLayers() {
    if ($('#layers').hidden || !project) return;
    const list = $('#layers-list');
    const q = $('#layers-search').value.trim().toLowerCase();
    const items = [
      ...project.nodes.map((n) => ({ id: n.id, kind: 'frame', name: n.label, meta: n.viewport })),
      ...(project.notes || []).map((t) => ({ id: t.id, kind: 'note', name: t.text.split('\n')[0] || 'Empty note', meta: t.pinned ? 'pinned note' : 'note' })),
    ].filter((it) => !q || it.name.toLowerCase().includes(q));
    list.innerHTML = items.length ? '' : '<li class="muted">Nothing found</li>';
    for (const it of items) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = `layer layer-${it.kind}`;
      b.setAttribute('aria-current', String(selection.has(it.id)));
      b.innerHTML = '<span class="name"></span><span class="meta"></span>';
      b.querySelector('.name').textContent = it.name;
      b.querySelector('.meta').textContent = it.meta;
      b.onclick = () => { select(it.id); zoomTo([it.id]); };
      li.append(b); list.append(li);
    }
  }
  $('#layers-search').addEventListener('input', renderLayers);
  $('#layers-btn').onclick = () => {
    const l = $('#layers'); l.hidden = !l.hidden;
    document.body.classList.toggle('layers-open', !l.hidden);
    $('#layers-btn').setAttribute('aria-expanded', String(!l.hidden));
    renderLayers();
    if (!l.hidden) $('#layers-search').focus();
  };

  // ---------------- selection & modes ----------------
  function select(id) { setSelection(id ? [id] : []); }
  function toggleSelect(id) { setSelection(selection.has(id) ? [...selection].filter((x) => x !== id) : [...selection, id]); }
  function setSelection(ids) {
    if (edgeSel) markEdge(null);
    if (ids.length === selection.size && ids.every((x) => selection.has(x))) return;
    selection.clear();
    for (const x of ids) selection.add(x);
    if (picked && picked.nodeId !== primary()) picked = null;
    for (const [fid, f] of frames) f.el.classList.toggle('selected', selection.has(fid));
    for (const [nid, el] of noteEls) el.classList.toggle('selected', selection.has(nid));
    placeTools();
    updateComposer();
    renderLayers();
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
      focusPrompt();
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

  // the two selected frames, in selection order, when exactly two frames are selected
  function pair() { const ids = [...selection]; return ids.length === 2 && ids.every((x) => positions[x]) ? ids : null; }
  function placeTools() {
    const two = mode === 'edit' && pair();
    const id = primary() || (two && two[0]);
    const p = id && positions[id];
    const n = id && project?.nodes.find((x) => x.id === id);
    if (!p || !n) { tools.hidden = true; return; }
    tools.hidden = false;
    tools.classList.toggle('pair', Boolean(two));
    const x = p.x * view.s + view.x;
    const yTop = p.y * view.s + view.y - 30; // just above the frame label
    const narrow = innerWidth < 720;
    tools.style.left = `${narrow ? 10 : Math.max($('#lefttools').getBoundingClientRect().right + 12, Math.min(x, rightEdge() - tools.offsetWidth - 12))}px`;
    tools.style.top = `${Math.max(tools.offsetHeight + 64, yTop)}px`;
    for (const b of tools.querySelectorAll('[data-vp]')) b.setAttribute('aria-checked', String(b.dataset.vp === n.viewport));
    tools.querySelector('[data-act="pick"]').setAttribute('aria-pressed', String(pickId === id));
    tools.querySelector('[data-act="interact"]').setAttribute('aria-pressed', String(interactId === id));
    tools.querySelector('[data-act="fit-height"]').setAttribute('aria-pressed', String(Boolean(fullHeight[id])));
    tools.querySelector('[data-act="favorite"]').setAttribute('aria-pressed', String(project.selected === id));
    tools.querySelector('[data-act="open"]').href = `/f/${encodeURIComponent(slug)}/${n.file}`;
  }

  function closeMenus() {
    for (const m of tools.querySelectorAll('[data-menu]')) { m.hidden = true; m.previousElementSibling.setAttribute('aria-expanded', 'false'); }
  }
  addEventListener('pointerdown', (e) => { if (!e.target.closest('#frame-tools .menu')) closeMenus(); }, true);
  // Escape closes an open popover first, before the global shortcuts see it
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tools.querySelector('[data-menu]:not([hidden])')) { closeMenus(); e.stopImmediatePropagation(); }
  }, true);

  tools.addEventListener('click', async (e) => {
    const b = e.target.closest('button,a');
    const id = primary();
    if (b?.dataset.act === 'link') { const two = pair(); if (two) linkFrames(two[0], two[1]); return; }
    if (!b || !id) return;
    if (b.dataset.vp) {
      const n = project.nodes.find((x) => x.id === id); n.viewport = b.dataset.vp;
      layoutAndRender();
      return api(`/nodes/${id}`, { method: 'PATCH', body: { viewport: b.dataset.vp } }).catch((er) => showToast(er.message));
    }
    const act = b.dataset.act;
    const pop = b.closest('[data-menu]');
    const field = (sel) => pop?.querySelector(sel);
    try {
      if (b.dataset.preset) { const t = field('textarea'); t.value = b.dataset.preset; t.focus(); }
      else if (b.dataset.pop) { const was = b.getAttribute('aria-expanded') === 'true'; closeMenus(); if (!was) { b.setAttribute('aria-expanded', 'true'); b.nextElementSibling.hidden = false; } }
      else if (act === 'send-update') { const t = field('textarea'); if (await sendRequest('iterate', { text: t.value })) { t.value = ''; closeMenus(); } }
      else if (act === 'send-variations') { if (await sendRequest('variations', { text: '', count: Number(field('select').value) })) closeMenus(); }
      else if (act === 'next-page-form') { const f = field('.next-page'); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('textarea').focus(); }
      else if (act === 'send-next-page') {
        const [t, l] = [field('.next-page textarea'), field('.next-page input')];
        if (await sendRequest('next-page', { text: t.value, label: l.value.trim() })) { t.value = l.value = ''; closeMenus(); }
      }
      else if (act === 'copy-prompt') { closeMenus(); $('#copy-prompt').click(); }
      else if (act === 'copy-html') {
        closeMenus();
        const html = await (await fetch(`/f/${encodeURIComponent(slug)}/${targetNode().file}`)).text();
        await navigator.clipboard.writeText(html); showToast('HTML copied');
      }
      else if (act === 'open') closeMenus();
      else if (act === 'pick') setPick(pickId === id ? null : id);
      else if (act === 'interact') setInteract(interactId === id ? null : id);
      else if (act === 'fit-height') { fullHeight[id] = !fullHeight[id]; savePref('fullHeight', fullHeight); layoutAndRender(); }
      else if (act === 'duplicate') { if (!canEdit()) return; const n = await api(`/nodes/${id}/duplicate`, { method: 'POST', body: {} }); await refresh(); select(n.id); }
      else if (act === 'favorite') { await api('/select', { method: 'POST', body: { nodeId: project.selected === id ? null : id } }); }
      else if (act === 'delete') deleteItems([id]);
    } catch (er) { showToast(er.message); }
  });

  async function renameNode(id) {
    if (!canEdit()) return;
    const n = project.nodes.find((x) => x.id === id);
    const label = prompt('Rename design', n.label);
    if (label && label !== n.label) await api(`/nodes/${id}`, { method: 'PATCH', body: { label } }).catch((e) => showToast(e.message));
  }

  // ---------------- nav edges ----------------
  // History steps find an edge by its ends, not its id: undo/redo re-create it under a new id.
  function edgeId(from, to) {
    const e = project.edges.find((x) => x.from === from && x.to === to);
    if (!e) throw new Error('That link no longer exists');
    return e.id;
  }
  const addEdge = (from, to, label = '') => api('/edges', { method: 'POST', body: { from, to, label } });
  const removeEdge = (from, to) => api(`/edges/${edgeId(from, to)}`, { method: 'DELETE' });
  const labelEdge = (from, to, label) => api(`/edges/${edgeId(from, to)}`, { method: 'PATCH', body: { label } });

  function linkFrames(from, to) {
    if (from === to || !canEdit()) return;
    undoable(() => addEdge(from, to), { label: 'Link', undo: () => removeEdge(from, to), redo: () => addEdge(from, to) });
  }

  function deleteEdge(id) {
    const e = project.edges.find((x) => x.id === id);
    if (!e || !canEdit()) return;
    const { from, to, label } = e;
    undoable(() => removeEdge(from, to), { label: 'Delete link', undo: () => addEdge(from, to, label), redo: () => removeEdge(from, to) });
  }

  // Highlight by class, not a redraw: replacing the clicked element would swallow its dblclick.
  function markEdge(id) {
    edgeSel = id;
    for (const el of document.querySelectorAll('#links .nav, #edge-labels span')) el.classList.toggle('selected', el.dataset.id === id);
  }
  function selectEdge(id) {
    select(null);
    markEdge(id);
  }

  function editEdgeLabel(id) {
    const e = project.edges.find((x) => x.id === id);
    if (!e || !positions[e.from] || !positions[e.to] || !canEdit()) return;
    selectEdge(id);
    const { from, to, label: old } = e;
    const g = edgeGeometry(positions[from], positions[to]);
    const input = document.createElement('input');
    input.className = 'edge-label';
    input.value = old;
    input.placeholder = 'Label';
    input.setAttribute('aria-label', 'Link label');
    Object.assign(input.style, { left: `${g.lx}px`, top: `${g.ly}px` });
    editingEdge = id;
    labelsEl.querySelector(`[data-id="${id}"]`)?.remove();
    labelsEl.append(input);
    input.focus(); input.select();
    let cancel = false;
    input.addEventListener('keydown', (ev) => {
      // stop here: once the input is gone the window handler would see Enter (open Agent) / Escape (deselect)
      if (ev.key === 'Enter') { ev.stopPropagation(); input.blur(); }
      else if (ev.key === 'Escape') { ev.stopPropagation(); cancel = true; input.blur(); }
    });
    input.addEventListener('blur', () => {
      if (editingEdge !== id) return;
      editingEdge = null; input.remove();
      const label = input.value.trim();
      if (cancel || label === old) { drawLinks(project.nodes); return; }
      undoable(() => labelEdge(from, to, label), { label: 'Rename link', undo: () => labelEdge(from, to, old), redo: () => labelEdge(from, to, label) });
    });
  }

  for (const layer of [links, labelsEl]) {
    layer.addEventListener('pointerdown', (e) => {
      const t = e.target.closest('.edge-hit, span.edge-label');
      if (!t || e.button !== 0 || space || tool === 'hand') return;
      e.stopPropagation();
      selectEdge(t.dataset.id);
    });
    layer.addEventListener('dblclick', (e) => {
      const t = e.target.closest('.edge-hit, span.edge-label');
      if (t && tool === 'select') editEdgeLabel(t.dataset.id);
    });
  }

  // ---------------- status ----------------
  for (const b of document.querySelectorAll('.status button')) {
    b.onclick = () => api('/status', { method: 'POST', body: { status: b.dataset.status, nodeId: primary() || project.selected || undefined } }).catch((e) => showToast(e.message));
  }

  // ---------------- composer ----------------
  function targetNode() { return project?.nodes.find((x) => x.id === primary()) || null; }

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

  // opts (from the frame toolbar popovers) override the composer: { text, count, label }
  function buildRequest(kind, opts = {}) {
    const n = targetNode();
    const text = (opts.text ?? promptEl.value).trim();
    if (kind === 'next-page') return { type: 'next-page', nodeId: n?.id || null, text, label: opts.label || '' };
    if (kind === 'variations') return { type: 'variations', nodeId: n?.id || null, text, count: opts.count ?? Number($('#var-count').value) };
    if (picked && n && picked.nodeId === n.id) return { type: 'element', nodeId: n.id, text, element: picked.element, viewport: n.viewport };
    return { type: 'iterate', nodeId: n?.id || null, text, viewport: n?.viewport || null };
  }

  async function sendRequest(kind, opts) {
    const body = buildRequest(kind, opts);
    if (!body.text && body.type !== 'variations') { if (!opts) promptEl.focus(); showToast('Describe the change first'); return false; }
    try {
      await api('/requests', { method: 'POST', body });
      if (!opts) { promptEl.value = ''; promptEl.style.height = 'auto'; }
      picked = null; updateComposer();
      const rn = project.runner || {};
      showToast(project.listening ? 'Sent — Claude is picking it up'
        : rn.enabled && rn.available ? (rn.running ? 'Queued — Claude Code takes it after the current run' : 'Sent — starting Claude Code')
          : 'Queued. Ask Claude to “check the design canvas” to pick it up');
      return true;
    } catch (e) { showToast(e.message); return false; }
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

  function setAgent(open) {
    $('#agent').hidden = !open;
    document.body.classList.toggle('agent-open', open);
    $('#agent-btn').setAttribute('aria-expanded', String(open));
    savePref('agent', open);
  }
  $('#agent-btn').onclick = () => setAgent($('#agent').hidden);
  $('#agent-close').onclick = () => setAgent(false);
  setAgent(loadPref('agent', false));
  const focusPrompt = () => { setAgent(true); promptEl.focus(); };

  // Who will handle a request: the interactive Claude Code session (listening), a background
  // Claude Code run (claude -p under the user's subscription), or nobody yet.
  function setListening(on) {
    if (project) project.listening = Boolean(on);
    const rn = project?.runner || {};
    const working = (project?.requests || []).filter((r) => r.status === 'claimed').length;
    const el = $('#listening');
    let txt; let tip; let live = true;
    if (on) { txt = 'Claude is listening'; tip = 'Your Claude Code session picks requests up right away.'; }
    else if (rn.running) { txt = 'Claude Code is working'; tip = 'A background Claude Code run (your subscription) is handling your requests. Open Agent to follow it.'; }
    else if (working) { txt = `Claude is working on ${working === 1 ? 'your request' : `${working} requests`}`; tip = 'New requests are queued and picked up when Claude finishes.'; }
    else if (rn.enabled && rn.available) { txt = 'Claude Code on call'; tip = `Requests start a background Claude Code run with your subscription (${rn.claude || 'claude'}). No API key is used.`; }
    else { live = false; txt = 'Claude isn’t listening'; tip = rn.available === false ? (rn.error || 'Claude Code CLI not found.') : 'Background runs are off. Ask Claude in your session to check the design canvas, or turn on “Run Claude Code automatically” in the Agent panel.'; }
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
    else if (e.key === '@' || (e.shiftKey && e.code === 'Digit2')) { if (selection.size) zoomTo([...selection]); }
    else if (e.key === '+' || e.key === '=' || e.key === '-') keyZoom(e.key);
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoRedo(e.shiftKey); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && edgeSel) deleteEdge(edgeSel);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) deleteItems([...selection]);
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && primary()) { e.preventDefault(); tools.querySelector('[data-act="duplicate"]').click(); }
    else if (e.metaKey || e.ctrlKey || e.altKey) { /* leave other shortcuts to the browser */ }
    else if (e.key.toLowerCase() === 'v') setTool('select');
    else if (e.key.toLowerCase() === 'h') setTool('hand');
    else if (e.key.toLowerCase() === 'n') setTool('note');
    else if (e.key.toLowerCase() === 'e' && primary()) setPick(pickId ? null : primary());
    else if (e.key.toLowerCase() === 'i' || e.key === 'Enter') { e.preventDefault(); focusPrompt(); }
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
