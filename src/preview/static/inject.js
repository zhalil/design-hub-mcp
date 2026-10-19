// Injected into every design frame on the canvas (only when served with ?hub=1).
// Reports page height, and implements element picking for targeted edits.
(() => {
  const me = document.currentScript;
  const node = me?.dataset.node;
  const post = (msg) => parent.postMessage({ dh: true, node, ...msg }, '*');

  // ---- height reporting (for "fit content height") ----
  let lastH = 0;
  const reportHeight = () => {
    const h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    if (Math.abs(h - lastH) > 2) { lastH = h; post({ type: 'height', h }); }
  };
  addEventListener('load', reportHeight);
  try { new ResizeObserver(reportHeight).observe(document.documentElement); } catch { setInterval(reportHeight, 1000); }

  // ---- element picking ----
  let picking = false;
  let hovered = null;
  const box = document.createElement('div');
  box.setAttribute('data-design-hub', '');
  Object.assign(box.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: 2147483647, border: '2px solid #f2c230',
    background: 'rgba(242,194,48,.12)', borderRadius: '2px', display: 'none', transition: 'all 60ms linear',
  });
  const tag = document.createElement('div');
  Object.assign(tag.style, {
    position: 'absolute', left: '-2px', bottom: '100%', marginBottom: '4px', background: '#1c1f1d', color: '#fff',
    font: '600 11px/1.6 system-ui,sans-serif', padding: '1px 6px', borderRadius: '3px', whiteSpace: 'nowrap',
  });
  box.appendChild(tag);

  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return `${s}#${el.id}`;
    const cls = [...el.classList].filter((c) => !/^(is-|has-)/.test(c)).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };

  const selectorFor = (el) => {
    if (el.dataset?.odId) return `[data-od-id="${el.dataset.odId}"]`;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let e = el;
    while (e && e.nodeType === 1 && e !== document.body && parts.length < 6) {
      if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
      if (e !== el && e.dataset?.odId) { parts.unshift(`[data-od-id="${e.dataset.odId}"]`); break; }
      let p = e.tagName.toLowerCase();
      const parentEl = e.parentElement;
      if (parentEl) {
        const same = [...parentEl.children].filter((c) => c.tagName === e.tagName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(p);
      e = e.parentElement;
    }
    return parts.join(' > ');
  };

  const show = (el) => {
    if (!el) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    tag.textContent = describe(el);
  };

  const onMove = (e) => {
    const el = e.target;
    if (!el || el === box || box.contains(el)) return;
    hovered = el;
    show(el);
  };
  const onClick = (e) => {
    if (!picking) return;
    e.preventDefault(); e.stopPropagation();
    const el = hovered || e.target;
    const r = el.getBoundingClientRect();
    const html = el.outerHTML.replace(/\s+/g, ' ');
    post({
      type: 'picked',
      element: {
        selector: selectorFor(el), label: describe(el), tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
        html: html.length > 1500 ? html.slice(0, 1500) + '…' : html,
        rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      },
    });
    setPicking(false);
  };
  const block = (e) => { if (picking) { e.preventDefault(); e.stopPropagation(); } };
  const onKey = (e) => {
    if (e.key === 'Escape') { if (picking) { setPicking(false); post({ type: 'pick-cancel' }); } else post({ type: 'key', key: 'Escape' }); }
  };

  function setPicking(on) {
    picking = on;
    if (on) {
      if (!box.isConnected) document.documentElement.appendChild(box);
      document.documentElement.style.cursor = 'crosshair';
      addEventListener('mousemove', onMove, true);
      addEventListener('click', onClick, true);
      for (const t of ['mousedown', 'mouseup', 'pointerdown', 'submit']) addEventListener(t, block, true);
    } else {
      document.documentElement.style.cursor = '';
      removeEventListener('mousemove', onMove, true);
      removeEventListener('click', onClick, true);
      for (const t of ['mousedown', 'mouseup', 'pointerdown', 'submit']) removeEventListener(t, block, true);
      show(null);
    }
  }

  addEventListener('keydown', onKey, true);
  // Ctrl/⌘ zoom inside a frame belongs to the canvas, not to the browser page
  addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    post({ type: 'wheel-zoom', deltaY: e.deltaY, deltaMode: e.deltaMode, x: e.clientX, y: e.clientY });
  }, { passive: false, capture: true });
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '0'].includes(e.key)) { e.preventDefault(); post({ type: 'key-zoom', key: e.key }); }
  }, true);
  addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.dh !== true) return;
    if (m.type === 'pick') setPicking(Boolean(m.on));
    if (m.type === 'highlight') {
      if (!m.selector) { if (!picking) show(null); return; }
      let el = null;
      try { el = document.querySelector(m.selector); } catch { /* bad selector */ }
      if (el) { if (!box.isConnected) document.documentElement.appendChild(box); el.scrollIntoView({ block: 'nearest' }); show(el); }
    }
  });
})();
