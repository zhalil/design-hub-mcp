# Superdesign-style Canvas (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Navigation edges between pages, sticky notes with pinned context that reaches Claude, and the Superdesign UI layout on the Design Hub canvas.

**Architecture:**
- **Data and API.** `project.json` gains `edges`, `notes` and `trash`. `src/workspace.js` owns them, `src/preview/http.js` exposes them as JSON routes, and `src/tools.js` exposes them as MCP tools. Pinned notes are added to every path that gives Claude a request.
- **Front end.** It stays vanilla JS with no build step. `canvas.js` becomes an ES module.
- **New front-end modules.** Pure logic (layout, edge geometry, undo history) moves to small modules that `node --test` can test. The DOM wiring stays in `canvas.js` plus a few focused UI modules.

**Tech Stack:**
- Node ≥ 20 ESM, `node:test`;
- `@modelcontextprotocol/sdk` (InMemoryTransport for tool tests), zod;
- `playwright-core` with system Chrome for the browser check;
- vanilla JS/CSS.

**Spec:** `docs/superpowers/specs/2026-10-19-superdesign-canvas-design.md` (in Russian; the decisions section "Решения автора дока" is binding).

## Global Constraints

- No React / React Flow, no bundler, no new npm dependencies.
- Navigation edge colour: `var(--signal)` = `#3b82f6`. Lineage links: thin grey dashed.
- Grid/snap step: 24 world px (same as the dot grid in `applyView`).
- Zoom range for the zoom menu: 10–300 %. Presets: 10, 25, 50, 75, 100, 150, 200, 300. `clampS` changes to `[0.1, 3]`.
- Note colours: `yellow` (default), `blue`, `green`, `pink`, `gray`.
- Pinned notes must reach Claude in all three paths:
  - `canvas_wait_feedback`;
  - `project_get`;
  - the background runner prompt.
- Undo covers only this tab's own actions. The stack is in memory, at most 100 steps.
- View/Edit:
  - the default is Edit, remembered via `savePref('mode')`;
  - View blocks move, create, delete, label/note editing and edge creation;
  - View allows selection, Interact, Open/Export and requests to Claude.
- Old projects without `edges` / `notes` / `trash` load with empty arrays.
- UI text is English, like the existing canvas.

## Review Focus

1. **Deleting a frame that has nav edges, then pressing Undo.** The frame, its edges, its children's `parent` and the "chosen" mark all come back. → Task 1 `restoreNode` test.
2. **Two edges between the same pair, or an edge from a node to itself.** Both are rejected with a clear error, and the UI shows a toast. → Task 1 `addEdge` test.
3. **A pinned note with a very long text (10 000 chars).** It reaches Claude untruncated in `project_get`. In the runner prompt the total pinned context is capped at 12 000 chars with a "(truncated, see project_get)" marker. → Task 3 runner prompt test.
4. **SSE refresh arriving while the user drags a frame or types in a note.** The local drag and edit are not overwritten. `refresh()` skips re-applying `pos` for nodes being dragged and `text` for the note being edited. → Task 6 browser check.
5. **A next-page node whose source was deleted.** Layout falls back to normal root placement with no crash, and the edge is already gone with the source. → Task 4 layout test.

---

### Task 1: Data model — edges, notes, trash/restore, next-page

**Files:**
- Modify: `src/workspace.js` (`loadProject`, `createProject`, `writeNode`, `deleteNode`, `REQUEST_TYPES`, `addRequest`; new functions below)
- Modify: `package.json` (add `"test": "node --test test/"`)
- Test: `test/workspace.test.js`

**Interfaces:**
- Produces (all exported from `src/workspace.js`; they throw `Error` with a readable message on bad input):
  - `addEdge(slug, { from, to, label = '' }) -> { id, from, to, label, kind: 'nav' }`
    - ids are `e1…`, from `p.seq.edge`;
    - rejects unknown nodes, `from === to`, and a duplicate `from→to`.
  - `updateEdge(slug, id, { label }) -> edge`
  - `deleteEdge(slug, id) -> edge` (returns the removed edge, for undo)
  - `addNote(slug, { text = '', pinned = false, color = 'yellow', pos = null, size = null }) -> note`
    - shape: `{ id: 't<n>', text, pinned, color, pos, size, createdAt, updatedAt }`;
    - `color` must be one of the 5 colours.
  - `updateNote(slug, id, patch) -> note` (patchable: `text`, `pinned`, `color`, `pos`, `size`)
  - `deleteNote(slug, id) -> note`
  - `pinnedContext(p) -> [{ id, text }]` (pinned notes in creation order)
  - `deleteNode(slug, id)` pushes `{ node, children: [ids], edges: [edge…], wasSelected, trashFile, deletedAt }` to `p.trash` and removes the node's edges.
  - `restoreNode(slug, id) -> node`
    - moves the file back from `.trash`;
    - re-inserts the node record and sets `parent = id` on the listed children that still exist;
    - restores edges whose both ends exist and restores `selected`;
    - throws if `id` is not in `trash`.
  - `writeNode(slug, { …, linkFrom = null, linkLabel = '' })`: when `linkFrom` is given, creates a nav edge `linkFrom → new node` after creating the node.
  - `REQUEST_TYPES` gains `'next-page'`; `addRequest` accepts and stores `label`.
  - `createProject({ name, brief })` creates one pinned note:
    - text: `` `Design Context\n\n${brief || 'Describe the product: who uses it, main flows, business rules.'}\n\nTokens and styles: DESIGN.md` ``
    - `pos: { x: -420, y: 0 }`, `size: { w: 360, h: 280 }`.

- [ ] **Step 1: Write failing tests** in `test/workspace.test.js`.
  - Setup:
    - set `process.env.DESIGN_HUB_HOME` / `DESIGN_HUB_WORKSPACE` to `fs.mkdtempSync` dirs **before** a dynamic `await import('../src/workspace.js')`;
    - create a project with nodes `a` and `b` via `writeNode`.
  - Tests:
    - `addEdge links two nodes`: returns `{ from: a, to: b, kind: 'nav' }` and `loadProject(...).edges.length === 1`.
    - `addEdge rejects self and duplicate`: `assert.throws` for `from===to` and for a second `a→b`.
    - `deleteNode removes edges and restoreNode brings everything back`:
      - setup: `c` is a child of `a`, `p.selected = a`, edge `a→b`;
      - `deleteNode(a)` gives no edges and `c.parent === null`;
      - `restoreNode(a)` gives the same id, `c.parent === a`, the edge is back, `selected === a`, and the file exists.
    - `restoreNode unknown id throws`.
    - `notes: add/update/delete and pinnedContext`: the context note from createProject plus one more pinned note gives `pinnedContext(p).length === 2`; unpinning gives 1.
    - `addNote rejects unknown colour`.
    - `writeNode linkFrom creates nav edge`.
    - `old project without edges/notes loads`: write a raw project.json without those keys, then `loadProject` returns `edges: [], notes: [], trash: []`.
    - `addRequest next-page keeps label`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (`addEdge is not a function`, …).
- [ ] **Step 3: Implement** the functions above in `src/workspace.js`.
  - Every mutation goes through the existing `save(p, event)` with events `edge`, `note`, `node-restored`.
  - `nextId` gains kinds `edge` (prefix `e`) and `note` (prefix `t`).
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(workspace): nav edges, notes with pinned context, node restore`.

### Task 2: HTTP routes

**Files:**
- Modify: `src/preview/http.js` (the `parts[1] === 'p'` block)
- Test: `test/http.test.js`

**Interfaces:**
- Consumes: Task 1 functions.
- Produces (JSON, errors → 400 `{ error }`, like existing routes):
  - `POST /api/p/<slug>/edges` → 201 edge;
  - `PATCH /api/p/<slug>/edges/<id>` → edge;
  - `DELETE /api/p/<slug>/edges/<id>` → removed edge;
  - `POST /api/p/<slug>/notes` → 201 note;
  - `PATCH /api/p/<slug>/notes/<id>` → note;
  - `DELETE /api/p/<slug>/notes/<id>` → removed note;
  - `POST /api/p/<slug>/nodes/<id>/restore` → node;
  - `GET /api/p/<slug>` already spreads the project, so it now includes `edges` and `notes`.
    - `trash` is removed from that payload: `const { trash, ...rest } = p`.

- [ ] **Step 1: Failing test** `test/http.test.js`.
  - Setup:
    - temp env as in Task 1, plus `DESIGN_HUB_PORT=7795`, `DESIGN_HUB_RUNNER=false`;
    - `startPreview()`, create a project with 2 nodes.
  - Then via `fetch`:
    - POST an edge (201);
    - GET the project: `edges.length === 1` and no `trash` key;
    - POST a note (201), PATCH `pinned: true`;
    - DELETE node a, then POST restore (200) and the node is back;
    - POST a duplicate edge gives 400 with an `error` message.
  - Close the server with `state.server.close()`: export `stopPreview()` from http.js for this.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (404 unknown endpoint).
- [ ] **Step 3: Implement** the routes and `stopPreview()`.
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(preview): edges, notes and restore endpoints`.

### Task 3: MCP — Claude reads and writes the canvas graph

**Files:**
- Modify: `src/tools.js`:
  - `nodeView`, `project_get`, `design_write`, `canvas_wait_feedback` and its `how` map;
  - new tools `canvas_link`, `canvas_note`.
- Modify: `src/runner.js` (prompt: context block, next-page instruction)
- Modify: `src/workflow.js`:
  - one rule: read `context`, link flow pages, offer to save product logic as a pinned note;
  - one line in the canvas loop for `next-page`.
- Test: `test/tools.test.js`

**Interfaces:**
- Consumes: Task 1 functions.
- Produces:
  - `nodeView(p, n)` adds `links: [{ to, label }]` (outgoing nav edges).
  - `project_get` adds:
    - `edges: [{ id, from, to, label }]`;
    - `context: pinnedContext(p)` (full text);
    - `notes: [{ id, text (first 200 chars), pinned }]`.
  - `canvas_wait_feedback` result adds a top-level `context` (same as project_get).
    - `how['next-page']`: `Create the next page of the flow: design_write(link_from="${n.id}", link_label="${r.label || '<a short label you choose>'}", no parent)`.
  - `design_write` gains `link_from?: string` and `link_label?: string`, passed to `writeNode` as `linkFrom` / `linkLabel`.
  - `canvas_link({ project, from, to, label?, remove? })`:
    - creates an edge, or with `remove: true` deletes the `from→to` edge;
    - returns `{ edge }` or `{ removed }`.
  - `canvas_note({ project, id?, text?, pinned?, color?, near?, remove? })`:
    - no `id` creates a note, placed next to node `near` when given (pos = that node's pos + width + 48, else null);
    - with `id` it patches the note, or deletes it when `remove: true`;
    - returns `{ note }`.
  - Runner prompt adds a section `Product context pinned by the user (follow it):` with the pinned notes.
    - The section is capped at 12 000 chars total; when cut, it ends with `… (truncated, see project_get context)`.
    - The `next-page` request is handled per the `how` text above.

- [ ] **Step 1: Failing test** `test/tools.test.js`.
  - Setup:
    - temp env;
    - `buildServer()` connected to `new Client()` via `InMemoryTransport.createLinkedPair()` (`@modelcontextprotocol/sdk/inMemory.js`);
    - project and nodes created through `ws` directly.
  - Tests:
    - `canvas_link creates an edge visible in project_get`: `JSON.parse(result.content[0].text).edges[0].from`.
    - `canvas_note pinned appears in project_get context`.
    - `design_write link_from creates edge`.
    - `runner prompt includes pinned context and truncates at 12000`: export the prompt builder from runner.js if it isn't already, and call it with a project holding a 15 000-char pinned note.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the tools, the prompt and workflow text as specified.
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(mcp): canvas_link, canvas_note, pinned context for Claude`.

### Task 4: Pure front-end modules — layout, edge geometry, history

**Files:**
- Create: `src/preview/static/layout.js`, `src/preview/static/history.js`
- Test: `test/layout.test.js`, `test/history.test.js`

**Interfaces:**
- Produces (`layout.js`, ES module, no DOM):
  - `GRID = 24`;
  - `snap(v) -> number` (nearest multiple of GRID);
  - `computeLayout(nodes, edges, sizeOf, { gapX = 140, gapY = 220 } = {}) -> { [id]: { x, y, w, h } }`:
    - keeps the current tree algorithm (moved from canvas.js);
    - plus: a root node without `pos` that has an incoming nav edge from a placed node is placed at `source.x + source.w + gapX*2`, `source.y`;
    - chains resolve in edge order, and a missing source falls back to normal root placement.
  - `autoLayout(nodes, edges, sizeOf) -> { [id]: { x, y } }`:
    - roots are ordered left→right by a topological walk of nav edges (unlinked roots last, by creation order);
    - iterations go in a column under their root (gapY 220);
    - all values are snapped.
  - `edgeGeometry(a, b) -> { d, lx, ly }`:
    - `a`, `b` are `{ x, y, w, h }`;
    - cubic Bézier from the side of `a` facing `b` to the facing side of `b`;
    - `(lx, ly)` is the curve midpoint for the label.
- Produces (`history.js`):
  - `createHistory(limit = 100) -> { push(step), undo(), redo(), canUndo(), canRedo(), clear() }`;
  - `step` is `{ undo: () => Promise|void, redo: () => Promise|void, label }`;
  - `push` clears the redo stack;
  - `undo` / `redo` return the step's label, or null when empty.

- [ ] **Step 1: Failing tests.**
  - `snap(37) === 48`, `snap(11) === 0`.
  - `next-page root sits right of its source`: source at pos `{0,0}`, w 1440, gives target `x === 1440 + 280`.
  - `missing source falls back`: an edge whose `from` is not in nodes does not throw.
  - `autoLayout orders flow A→B→C left to right`: `x(A) < x(B) < x(C)`.
  - `edgeGeometry picks facing sides`: for b right of a, `d` starts at `a.x + a.w`.
  - history:
    - push/undo/redo call the right closures;
    - push after undo clears redo;
    - limit 2 drops the oldest step.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** both modules. Move `computeLayout` from `canvas.js` unchanged in behaviour, plus the nav rule.
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(canvas): layout, edge geometry and undo history modules`.

### Task 5: UI shell — Superdesign layout, Agent panel, browser check

**Files:**
- Modify: `src/preview/static/canvas.html`, `canvas.css`, `canvas.js` (now `<script type="module">`, imports `layout.js` and `history.js`)
- Create: `src/preview/static/minimap.js`: `createMinimap(el, { getPositions, getView, setView })` returning `{ draw() }`. A 200×140 `<canvas>` with rectangles only, click/drag recentres the view.
- Create: `scripts/canvas-check.mjs` (port the zoom assertions from the old scratch check; add a `npm run check:canvas` script)

**Interfaces:**
- Consumes: Task 4 modules.
- Produces the DOM ids later tasks use:
  - `#header` (top-left: home, `#project-name`, status segment, `#layers-btn`);
  - `#viewbar` (top-centre: `#fit-btn`, `#zoom-menu` button + popover with presets, `#mode` segment `view|edit`);
  - `#topright` (`#minimap`, `#listening`, `#agent-btn` with pending count);
  - `#lefttools`, vertical, with buttons:
    - `data-tool="select|hand"`;
    - `data-act="note|autolayout|duplicate|pinned"`;
    - `#pinned-count` on the pinned button;
  - `#agent` (right panel, hidden by default, remembered with `savePref('agent')`). It holds:
    - the existing composer form (moved from the bottom);
    - the existing activity sections;
  - `#layers` (left panel: search input plus a list of frames and notes; click → `zoomTo([id])`).
  - `canvas.js` state additions used by later tasks:
    - `mode` (`'edit'|'view'`);
    - `tool` (`'select'|'hand'`);
    - `selection: Set<string>` (node and note ids), replacing `selectedId` (keep a `primary()` helper returning the single selected node id or null);
    - `history` (from `createHistory()`).
- Keyboard: V / H switch tool, N note tool (Task 7), Shift+1 fit, Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z redo (wired here to `history`).

- [ ] **Step 1: Write `scripts/canvas-check.mjs`.**
  - Setup:
    - temp env, `startPreview()`, a project with 2 nodes;
    - Chrome via `playwright-core` `chromium.launch({ channel: 'chrome' })`, falling back to the bundled browser.
  - Assertions:
    - the zoom checks from before still pass;
    - `#agent` is hidden, clicking `#agent-btn` shows it, and `#prompt` is inside `#agent`;
    - `#minimap` canvas has non-zero size;
    - the `#zoom-menu` preset "300%" makes `#zoom-level` read `300%`;
    - pressing `H` then dragging the mat pans;
    - `#mode` set to View, then a drag on a frame label does not change its position.
  - Prints `canvas check ok`, exits 1 on the first failure.
- [ ] **Step 2: Run** `node scripts/canvas-check.mjs`. Expected: FAIL (`#agent` not found).
- [ ] **Step 3: Implement** the layout, panels and minimap.
  - Remove the bottom composer position.
  - Remove the rulers; Superdesign has none, and the minimap replaces them for orientation.
  - Set `clampS` to `[0.1, 3]`.
- [ ] **Step 4: Run** `node scripts/canvas-check.mjs && npm test`. Expected: `canvas check ok`, tests pass.
- [ ] **Step 5: Screenshot** to `$TMPDIR` and compare by eye with the Superdesign reference (dark floating panels, minimap top-right, left vertical toolbar).
- [ ] **Step 6: Commit** `feat(canvas): Superdesign layout with Agent panel, minimap, layers`.

### Task 6: Navigation edges in the UI

**Files:**
- Modify: `canvas.js` (edge rendering in `drawLinks`, connection handles, label editing, Link action, filter)
- Modify: `canvas.css`, `canvas.html` (show-connections control in `#viewbar`: `all | nav | none`, remembered)
- Modify: `scripts/canvas-check.mjs`

**Interfaces:**
- Consumes:
  - `edgeGeometry` (Task 4), `history` (Task 5);
  - HTTP edges routes (Task 2);
  - `project.edges` from the refresh payload.
- Behaviour:
  - nav edges are SVG paths in `#links`, with a `marker-end` arrow in `var(--signal)`;
  - the label is a `<foreignObject>`-free HTML pill positioned in world coordinates at `(lx, ly)`;
  - lineage edges use the `.lineage` class (grey dashed);
  - Edit mode shows a round handle on the right edge of the hovered or selected frame. Dragging it draws a temp edge, and dropping on another frame POSTs the edge (pushed to history: undo = DELETE, redo = POST again).
    - Self-drop is ignored.
    - A server 400 shows as a toast.
  - with exactly two frames selected, the frame toolbar shows **Link** (first selected → second);
  - clicking an edge selects it (highlight). Delete removes it (undoable), and a double-click on the label edits it inline (PATCH, undoable).
  - SSE refresh never clobbers an in-progress drag or label edit (Review Focus 4).

- [ ] **Step 1: Extend the check.**
  - Create an edge via API, then `#links path.nav` count is 1 and the label pill text matches.
  - Drag the handle from frame A to B (two nodes, no existing edge, after deleting the first via API), then the GET payload has 1 edge.
  - Ctrl+Z, then 0 edges; Ctrl+Shift+Z, then 1.
  - Filter `none`: no `path.nav` visible.
  - Start dragging frame A, fire a `change` SSE (PATCH a note via API) mid-drag, and the frame stays under the pointer.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the check and `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(canvas): navigation edges with labels, linking and filter`.

### Task 7: Notes and Pinned Context in the UI

**Files:**
- Modify: `canvas.js`, `canvas.css`, `canvas.html`
- Modify: `scripts/canvas-check.mjs`

**Interfaces:**
- Consumes: notes routes (Task 2), `project.notes`, `history`, `snap`.
- Behaviour:
  - notes render as `.note` elements in `#world` at `pos` (default size 280×200), with a colour class `note-<color>`;
  - each note has a header with a pin toggle (📌 filled when pinned), a colour dots menu and a delete ×;
  - the body is a `<textarea>` styled as the sticky. It is plain text shown with line breaks, no markdown rendering, saved on blur and after 600 ms idle (PATCH);
  - the N tool, or the left-toolbar note button, then a click on the mat creates a note at the snapped click point (undoable) and focuses it;
  - notes drag by the header, snapped, and move with group drag (Task 8);
  - the `#pinned-count` badge shows the pinned count. Clicking it opens a popover listing pinned notes (first line plus a "Go to" button), with the hint text: `Pinned notes are sent to Claude with every request.`;
  - View mode: textarea read-only, no drag, no create/delete.

- [ ] **Step 1: Extend the check.**
  - A new project shows the "Design Context" note with `pinned` class, and `#pinned-count` reads 1.
  - Press N and click the mat: a note appears; type "Users are dispatchers", blur, and GET shows the text.
  - Pin it: `#pinned-count` reads 2.
  - Ctrl+Z after creation removes it.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the check and `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(canvas): sticky notes and pinned context`.

### Task 8: Selection, group move, snap, undo of moves and deletes, auto layout

**Files:**
- Modify: `canvas.js`, `canvas.css`
- Modify: `scripts/canvas-check.mjs`

**Interfaces:**
- Consumes: `selection`, `history`, `snap`, `autoLayout`, the restore route.
- Behaviour:
  - Shift+click toggles membership. Rubber band on empty mat in the select tool selects frames and notes it intersects; a plain drag with the hand tool, Space or the middle button still pans.
  - Dragging any selected item moves the whole selection, snapped to 24 on drop. One history step restores all previous positions via PATCH.
  - Delete on a selection deletes all of it after one confirm.
    - The history step's undo calls `POST …/nodes/<id>/restore` for frames and re-creates notes and edges by POST.
    - Recreated notes and edges get new ids. That is fine: they are not referenced elsewhere.
  - The Auto layout button PATCHes every changed frame `pos` from `autoLayout`, as one undoable step.
  - The Duplicate button duplicates the primary frame (existing route).
  - Typing in a textarea or input never triggers canvas shortcuts (existing `typing()` guard).

- [ ] **Step 1: Extend the check.**
  - Shift-select both frames, drag 100 px: both `pos` change by the same snapped delta; Ctrl+Z restores both.
  - Delete frame A that has an edge, then Ctrl+Z: the frame and edge are back (GET), and the same id is kept.
  - Rubber band around both frames: the selection size is 2.
  - Auto layout on A→B with B placed left of A gives `x(A) < x(B)`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the check and `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(canvas): multi-select, snap, undo, auto layout`.

### Task 9: Frame toolbar — Update presets, Create New, Pin, Export

**Files:**
- Modify: `canvas.html` (`#frame-tools` contents), `canvas.js`, `canvas.css`
- Modify: `scripts/canvas-check.mjs`

**Interfaces:**
- Consumes:
  - `sendRequest` / `buildRequest` (extend with `'next-page'`);
  - `POST /requests` with `{ type: 'next-page', nodeId, text, label }`.
- Toolbar, left to right:
  - **Update ▾** opens a popover:
    - a textarea;
    - preset chips that prefill text — Color: `Rework the colour palette: `, Layout: `Change the layout: `, Style: `Change the visual style: `, Typography: `Improve the typography: `;
    - Send gives an `iterate` request, or `element` if an element is picked.
  - **Create New ▾**:
    - `Variations` with count 2–5 gives `variations`;
    - `Next page in flow` gives a popover with "What page?" text and an optional "Link label" field, which creates a `next-page` request.
  - Select element · Interact · viewport segment · Full height.
  - **Pin** (the old Choose; `aria-pressed` when `project.selected === id`).
  - **Export ▾**: Copy prompt (existing builder) · Copy HTML (fetch `/f/<slug>/<file>`, then clipboard) · Open.
  - **Delete**.
- The Agent panel composer keeps working for free-form requests on the primary selection.

- [ ] **Step 1: Extend the check.**
  - Update → Color preset → Send: the GET requests list has a pending `iterate` whose text starts with `Rework the colour palette`.
  - Create New → Next page, text "Checkout", label "Buy": a pending `next-page` with `label: 'Buy'`.
  - Export → Copy HTML: the clipboard contains `<html` (grant `clipboard-read` in the Playwright context).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the check and `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(canvas): Superdesign-style frame toolbar`.

### Task 10: Docs and release

**Files:**
- Modify: `README.md`: the canvas section covers edges, notes and pinned context, View/Edit, hotkeys V/H/N, Ctrl+Z, and the new MCP tools.
- Modify: `.claude-plugin/plugin.json` and `package.json` version → `0.2.0`.

- [ ] **Step 1: Run** `npm test && node scripts/canvas-check.mjs`. Expected: both green.
- [ ] **Step 2: Update** the README and the versions.
- [ ] **Step 3: Commit** `docs: canvas phase 1` and push.
