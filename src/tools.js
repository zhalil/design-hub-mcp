// All Design Hub MCP tools. buildServer() is used for the interactive stdio session (Claude Code)
// and, with worker=true, for background Claude Code runs that connect over HTTP.
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, ensureDirs, log, PKG_DIR, readJson } from './config.js';
import * as sources from './sources.js';
import * as cat from './catalog.js';
import * as uipro from './uipro.js';
import * as ws from './workspace.js';
import * as render from './render.js';
import * as skills from './skills.js';
import { openBrowser } from './open.js';
import { previewInfo, projectUrl, nodeUrl, critiqueUrl, viewersOf, setWaiting } from './preview/http.js';
import { WORKFLOW, ITERATE_PROMPT, DESIGN_PROMPT } from './workflow.js';

export const VERSION = readJson(path.join(PKG_DIR, 'package.json'), {}).version || '0.0.0';

// ---------- startup: sources are cloned lazily on first run ----------
let sourcesError = null;
let sourcesReady = null;
let sourcesDone = false;
export function startHub() {
  if (sourcesReady) return sourcesReady;
  ensureDirs();
  sourcesReady = sources.ensureSources({ onProgress: (m) => log(m), onCloned: () => cat.invalidateCatalog() })
    .then((cloned) => { if (cloned.length) log(`cloned: ${cloned.join(', ')}`); })
    .catch((e) => { sourcesError = e; log(`source setup failed: ${e.message}`); })
    .finally(() => {
      sourcesDone = true;
      setTimeout(() => sources.maybeBackgroundCheck(async () => { cat.invalidateCatalog(); skills.resyncInstalled(); }), 5000).unref?.();
    });
  return sourcesReady;
}

async function needSources() {
  // startHub() unpacks the bundled snapshot synchronously, so the catalog is usually ready right away.
  startHub();
  if (cat.catalog().items.length) return;
  // No snapshot: a first download over a slow link can take many minutes, so wait only a little.
  await Promise.race([startHub(), new Promise((r) => setTimeout(r, 20000).unref?.())]);
  if (cat.catalog().items.length) return;
  if (!sourcesDone) throw new Error('Upstream sources (OpenDesign, huashu-design, UI UX Pro Max) are still downloading on first run. Try again in a few minutes; hub_status shows progress.');
  if (sourcesError) throw new Error(`Upstream sources are not available: ${sourcesError.message}. Check git/network (HTTPS_PROXY is honoured) and run hub_update action=apply.`);
}

// ---------- helpers ----------
const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const shouldOpen = (event) => config.openMode !== 'never' && (config.openMode === 'always' || event === 'ready' || event === 'review' || event === 'explicit');

function nodeView(p, n) {
  return { id: n.id, label: n.label, parent: n.parent, viewport: n.viewport, revision: n.revision || 1, file: ws.nodeFile(p.slug, n), url: nodeUrl(p.slug, n), links: p.edges.filter((e) => e.from === n.id).map((e) => ({ to: e.to, label: e.label })) };
}

function updateNotice() {
  const check = sources.lastCheck();
  const pending = check?.results?.filter((r) => r.upToDate === false) || [];
  if (!pending.length) return null;
  return `Upstream updates available for ${pending.map((r) => r.id).join(', ')} (checked ${check.checkedAt}). Run hub_update action=check for details, action=apply to pull.`;
}

export function buildServer({ worker = false } = {}) {
  const server = new McpServer({ name: 'design-hub', version: VERSION }, {
    instructions: 'Design Hub: design systems, templates, skills and craft rules pulled from OpenDesign, huashu-design and UI UX Pro Max, plus a live canvas preview. Call hub_workflow before starting a design task.',
  });
  const tool = (name, description, inputSchema, handler) => {
    server.registerTool(name, { description, inputSchema }, async (args, extra) => {
      try { return await handler(args || {}, extra); } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
      }
    });
  };
  // background runs never open browser windows — the user is already looking at the canvas
  const maybeOpen = worker ? () => ({ opened: false, reason: 'background Claude Code run' }) : openBrowser;

  // =====================================================================
  // Hub & sources
  // =====================================================================
  tool('hub_workflow',
    'Start here. Returns the Design Hub pipeline: which upstream source owns which decision, conflict rules, and the step-by-step loop (direction → build → lint/critique → canvas feedback → ready).',
    {},
    async () => {
      startHub();
      const notice = updateNotice();
      return text(`${WORKFLOW}\n## Catalog right now\n${JSON.stringify(cat.stats(), null, 1)}\nPreview: ${previewInfo().url}${notice ? `\n\n> ${notice}` : ''}`);
    });

  tool('hub_status',
    'Status of Design Hub: preview server URL, workspace folder, upstream sources (commit, update availability), catalog counts, installed skills, rendering browser.',
    { check_browser: z.boolean().optional().describe('Also try launching the headless browser used by design_lint/design_screenshot') },
    async ({ check_browser }) => {
      startHub();
      return text({
        version: VERSION, preview: previewInfo(), hubHome: config.hubHome, sourcesFile: config.sourcesFile,
        sources: sources.sourcesStatus(), catalog: cat.stats(), styleEngine: Boolean(uipro.engineScript()),
        installedSkills: skills.listInstalled(), lastUpdateCheck: sources.lastCheck()?.checkedAt || null,
        updateNotice: updateNotice(), browser: check_browser ? await render.browserAvailable() : 'not checked',
        sourcesDownloading: !sourcesDone, sourcesError: sourcesError?.message || null,
      });
    });

  tool('hub_update',
    'Update skills, rules, design systems and templates from the parent repositories. action=check fetches and reports what would change (added/removed/changed items per kind) without touching anything; apply pulls the latest commit of each source (catalog and installed skills follow automatically); rollback returns sources to the commit before the last update.',
    {
      action: z.enum(['check', 'apply', 'rollback']),
      sources: z.array(z.string()).optional().describe('Limit to these source ids (see hub_status); default all enabled'),
    },
    async ({ action, sources: ids }) => {
      let result;
      if (action === 'check') result = await sources.checkUpdates({ ids });
      else if (action === 'apply') result = await sources.applyUpdates({ ids });
      else result = await sources.rollback({ ids });
      if (action !== 'check') {
        cat.invalidateCatalog();
        const resynced = skills.resyncInstalled();
        return text({ action, result, installedSkillsResynced: resynced, catalog: cat.stats() });
      }
      return text(result);
    });

  // =====================================================================
  // Catalog: design systems, templates, skills, rules, references
  // =====================================================================
  tool('catalog_search',
    'Search everything pulled from upstream (and your local overrides): kind=systems (DESIGN.md brand systems, e.g. linear-app, stripe), templates (rendering blueprints: saas-landing, dashboard, mobile-app, html-ppt-*, critique…), skills (huashu-design, ui-ux-pro-max, OpenDesign functional skills), rules (craft rules: anti-ai-slop, typography, color, laws-of-ux…), references (huashu-design references). Empty query lists items.',
    {
      query: z.string().default(''),
      kind: z.enum(['all', 'systems', 'templates', 'skills', 'rules', 'references']).default('all'),
      source: z.string().optional().describe('e.g. open-design, huashu-design, ui-ux-pro-max, local'),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ query, kind, source, limit }) => {
      await needSources();
      const items = cat.search(query, { kind, source, limit });
      return text({ count: items.length, items: items.map(cat.summarize) });
    });

  tool('catalog_get',
    'Load one catalog item in full. Templates and skills come with their SKILL.md, the folder path and file list (Read referenced files directly), and — for templates — the craft rules they require, appended automatically. Systems return DESIGN.md (or part=tokens/tailwind/json/usage/components; lang=ru etc. for translations). Long content is paginated: pass offset=next to continue.',
    {
      id: z.string().describe('Catalog id "source/name" or a bare name'),
      kind: z.enum(['systems', 'templates', 'skills', 'rules', 'references']).optional(),
      part: z.enum(['design', 'tokens', 'tailwind', 'json', 'usage', 'components', 'example']).optional(),
      lang: z.string().optional(),
      offset: z.number().int().min(0).default(0),
      with_rules: z.boolean().default(true),
    },
    async ({ id, kind, part, lang, offset, with_rules }) => {
      await needSources();
      const it = cat.findItem(id, kind);
      if (!it) {
        const near = cat.search(id, { kind: kind || 'all', limit: 6 }).map((x) => x.id);
        throw new Error(`"${id}" not found.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`);
      }
      let body = cat.readItemText(it, { part, lang });
      const header = { id: it.id, kind: it.kind, title: it.title };
      if (it.dir) { header.dir = it.dir; }
      if (it.file) header.file = it.file;
      if (it.kind === 'systems') Object.assign(header, { files: it.files, languages: it.languages, suggestedRules: it.suggestedRules });
      if (it.kind === 'templates' || it.kind === 'skills') {
        header.files = cat.fileTree(it.dir);
        if (with_rules && it.rules?.length && part !== 'example') {
          const { found, missing } = cat.resolveRules(it.rules);
          header.rules = found.map((r) => r.id);
          if (missing.length) header.missingRules = missing;
          body += `\n\n---\n# Craft rules required by this template\n${found.map((r) => `\n## Rule: ${r.id}\n${cat.readItemText(r)}`).join('\n')}`;
        }
      }
      if (offset > 0 && offset >= body.length) return text(`Offset ${offset} is past the end (content is ${body.length} characters). Use offset=0.`);
      const pg = cat.page(body, offset);
      const head = offset === 0 ? `${JSON.stringify(header, null, 2)}\n\n` : '';
      const tail = pg.next !== null ? `\n\n[… ${pg.total - pg.next} more characters — call catalog_get again with offset=${pg.next}]` : '';
      return text(`${head}${pg.text}${tail}`);
    });

  tool('skills_install',
    'Install upstream skills as native Claude Code skills (so they load by themselves in future sessions) and keep them synced on hub_update. scope=user → ~/.claude/skills, project → ./.claude/skills. mode=link follows updates instantly (symlink), copy refreshes on update. Install only a few — every installed skill adds to the context. Call with no ids to list installed skills.',
    {
      ids: z.array(z.string()).default([]),
      scope: z.enum(['user', 'project']).default('user'),
      mode: z.enum(['link', 'copy']).default('link'),
      uninstall: z.boolean().default(false),
    },
    async ({ ids, scope, mode, uninstall }) => {
      await needSources();
      if (!ids.length) return text({ installed: skills.listInstalled() });
      if (uninstall) return text(skills.uninstallSkills(ids));
      const res = skills.installSkills(ids, { scope, mode });
      return text({ results: res, note: 'Claude Code picks up new skills in new sessions (or after /reload).' });
    });

  // =====================================================================
  // UI UX Pro Max
  // =====================================================================
  tool('style_design_system',
    'UI UX Pro Max: recommend a complete design system for a product (pattern, style, color roles with hex, font pairing, key effects, anti-patterns, pre-delivery checklist). Use in the direction phase; query = product type + audience + mood, e.g. "fintech dashboard for analysts, calm, precise".',
    {
      query: z.string(),
      project_name: z.string().optional(),
      variance: z.number().int().min(1).max(10).optional().describe('1 centered/minimal … 10 bold/asymmetric'),
      motion: z.number().int().min(1).max(10).optional(),
      density: z.number().int().min(1).max(10).optional().describe('1 spacious … 10 dense dashboard'),
    },
    async ({ query, project_name, variance, motion, density }) => {
      await needSources();
      return text(await uipro.styleDesignSystem({ query, projectName: project_name, variance, motion, density }));
    });

  tool('style_search',
    'UI UX Pro Max BM25 search. domain: style, color, chart, landing, product, ux, typography, google-fonts, icons, gsap, react, web. Or stack (react, nextjs, vue, svelte, astro, swiftui, react-native, flutter, html-tailwind, shadcn, …) for stack-specific implementation rules.',
    {
      query: z.string(),
      domain: z.enum(['style', 'color', 'chart', 'landing', 'product', 'ux', 'typography', 'google-fonts', 'icons', 'gsap', 'react', 'web']).optional(),
      stack: z.string().optional(),
      max_results: z.number().int().min(1).max(20).default(3),
    },
    async ({ query, domain, stack, max_results }) => {
      await needSources();
      return text(await uipro.styleSearch({ query, domain, stack, maxResults: max_results }));
    });

  // =====================================================================
  // Projects & canvas
  // =====================================================================
  function copySystemInto(slug, item, lang) {
    const dir = ws.projectDir(slug);
    const designSrc = lang && fs.existsSync(path.join(item.dir, `DESIGN-${lang}.md`)) ? `DESIGN-${lang}.md` : 'DESIGN.md';
    fs.copyFileSync(path.join(item.dir, designSrc), path.join(dir, 'DESIGN.md'));
    const copied = ['DESIGN.md'];
    for (const f of ['tokens.css', 'tailwind-v4.css', 'design-tokens.json']) {
      if (fs.existsSync(path.join(item.dir, f))) { fs.copyFileSync(path.join(item.dir, f), path.join(dir, f)); copied.push(f); }
    }
    ws.setDesignSystem(slug, { id: item.id, title: item.title, source: item.source });
    return copied;
  }

  tool('project_create',
    'Create a design project (a canvas). Optionally start from an upstream design system (catalog id, e.g. "open-design/linear-app") — its DESIGN.md and tokens.css are copied into the project. Returns the project slug, folder and canvas URL.',
    {
      name: z.string(),
      brief: z.string().default('').describe('What is being designed, for whom, constraints'),
      design_system: z.string().optional(),
      lang: z.string().optional().describe('Prefer a translated DESIGN.md if the system has one (e.g. "ru")'),
    },
    async ({ name, brief, design_system, lang }) => {
      let item = null;
      if (design_system) {
        await needSources();
        item = cat.findItem(design_system, 'systems');
        if (!item) throw new Error(`Design system "${design_system}" not found. Use catalog_search kind=systems.`);
      }
      const p = ws.createProject({ name, brief });
      const copied = item ? copySystemInto(p.slug, item, lang) : [];
      const url = projectUrl(p.slug);
      if (config.openMode === 'always') maybeOpen(url);
      return text({ project: p.slug, dir: ws.projectDir(p.slug), canvas: url, designSystem: item?.id || null, copied, next: item ? 'DESIGN.md is set — build with a template (step 2) or show 3 in-system variations.' : 'Run the direction phase (hub_workflow step 1).' });
    });

  tool('project_list', 'List design projects in this workspace.', {}, async () => {
    return text({ workspace: config.workspace, preview: previewInfo().url, projects: ws.listProjects().map((p) => ({ project: p.slug, name: p.name, status: p.status, designs: p.nodes.length, queued: p.requests.filter((r) => r.status === 'pending').length, updatedAt: p.updatedAt, canvas: projectUrl(p.slug) })) });
  });

  tool('project_get',
    'Full state of a project: brief, status, design system, the canvas tree (nodes with file paths you can Read/Edit), the chosen node, open requests from the canvas and recent critiques.',
    { project: z.string() },
    async ({ project }) => {
      const p = ws.loadProject(project);
      return text({
        project: p.slug, name: p.name, brief: p.brief, status: p.status, chosen: p.selected || null, designSystem: p.designSystem,
        dir: ws.projectDir(p.slug), designMd: fs.existsSync(path.join(ws.projectDir(p.slug), 'DESIGN.md')) ? path.join(ws.projectDir(p.slug), 'DESIGN.md') : null,
        canvas: projectUrl(p.slug), viewers: viewersOf(p.slug),
        tree: ws.treeSummary(p),
        edges: p.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label })),
        context: ws.pinnedContext(p),
        notes: p.notes.map((n) => ({ id: n.id, text: n.text.slice(0, 200), pinned: n.pinned })),
        nodes: p.nodes.map((n) => nodeView(p, n)),
        openRequests: p.requests.filter((r) => r.status === 'pending' || r.status === 'claimed'),
        critiques: p.critiques.slice(-5).map((c) => ({ id: c.id, node: c.nodeId, verdict: c.verdict, url: critiqueUrl(p.slug, c.id) })),
      });
    });

  tool('design_md_set',
    'Set the project\'s DESIGN.md — the single source of truth for tokens. Either from_system (catalog id of an upstream system; copies DESIGN.md + tokens.css) or content (markdown you wrote, e.g. from the chosen direction and style_design_system output).',
    {
      project: z.string(),
      from_system: z.string().optional(),
      content: z.string().optional(),
      title: z.string().optional(),
      lang: z.string().optional(),
    },
    async ({ project, from_system, content, title, lang }) => {
      const p = ws.loadProject(project);
      if (from_system) {
        await needSources();
        const item = cat.findItem(from_system, 'systems');
        if (!item) throw new Error(`Design system "${from_system}" not found.`);
        const copied = copySystemInto(p.slug, item, lang);
        return text({ ok: true, copied, path: path.join(ws.projectDir(p.slug), 'DESIGN.md') });
      }
      if (!content?.trim()) throw new Error('Pass from_system or content.');
      const file = path.join(ws.projectDir(p.slug), 'DESIGN.md');
      fs.writeFileSync(file, content);
      ws.setDesignSystem(p.slug, { id: 'custom', title: title || content.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Custom', source: 'project' });
      return text({ ok: true, path: file });
    });

  tool('design_write',
    'Put a design on the canvas: a complete, self-contained HTML page. No parent → a new root (e.g. one of 3 directions). parent=<node> → an iteration/variation shown next to its parent. node=<node> → overwrite that node in place (new revision). Pass html, or file = path of an HTML file you already wrote. The canvas live-reloads. Returns the node id, its file path (you may Edit it directly afterwards) and quick static lint counts.',
    {
      project: z.string(),
      html: z.string().optional(),
      file: z.string().optional().describe('Read the HTML from this file instead of the html argument'),
      parent: z.string().optional(),
      node: z.string().optional(),
      label: z.string().optional().describe('Short name shown on the canvas, e.g. "Direction B — editorial"'),
      note: z.string().optional(),
      viewport: z.enum(['desktop', 'tablet', 'mobile']).optional(),
      request_id: z.string().optional().describe('The canvas request this answers (also resolve it with feedback_resolve)'),
      link_from: z.string().optional().describe('Also draw a flow arrow from this node to the new one (next page of a flow)'),
      link_label: z.string().optional().describe('Arrow label, e.g. the button text'),
    },
    async (a) => {
      let html = a.html;
      if (!html && a.file) html = fs.readFileSync(path.resolve(a.file), 'utf8');
      if (!html?.trim()) throw new Error('Pass html or file.');
      if (!/<html|<body|<!doctype/i.test(html)) html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}</body></html>`;
      const { project: p, node } = ws.writeNode(a.project, { html, parent: a.parent, node: a.node, label: a.label, note: a.note, viewport: a.viewport, requestId: a.request_id, linkFrom: a.link_from, linkLabel: a.link_label });
      const issues = render.staticLint(html);
      if (config.openMode === 'always' && !viewersOf(p.slug)) maybeOpen(projectUrl(p.slug, node.id));
      return text({
        node: nodeView(p, node), canvas: projectUrl(p.slug, node.id), viewers: viewersOf(p.slug),
        staticLint: issues.length ? issues.map((i) => `${i.severity} ${i.rule}: ${i.message}`) : 'clean',
        hint: 'Run design_lint / design_screenshot to check the rendered result.',
      });
    });

  tool('design_status',
    'Set project status. "review" = designs are ready for the user to look at (opens the canvas in the browser if nobody has it open). "ready" = the chosen design is done: marks node as chosen and opens it in the browser. "draft" = work in progress.',
    {
      project: z.string(),
      status: z.enum(['draft', 'review', 'ready']),
      node: z.string().optional().describe('The chosen/finished design'),
      open: z.boolean().optional().describe('Force (true) or suppress (false) opening the browser'),
    },
    async ({ project, status, node, open }) => {
      const p = ws.setStatus(project, status, node);
      const url = projectUrl(p.slug, node || p.selected || undefined);
      let opened = { opened: false, reason: 'not requested' };
      const want = open === true || (open !== false && ((status === 'ready' && shouldOpen('ready')) || (status === 'review' && shouldOpen('review') && !viewersOf(p.slug))));
      if (want) opened = maybeOpen(url, { force: open === true });
      else if (status === 'review' && viewersOf(p.slug)) opened = { opened: false, reason: 'canvas is already open' };
      return text({ project: p.slug, status, chosen: p.selected || null, canvas: url, ...opened });
    });

  tool('canvas_open', 'Open the canvas (or a specific design) in the user\'s browser.', {
    project: z.string().optional(), node: z.string().optional(),
  }, async ({ project, node }) => {
    const url = project ? projectUrl(ws.loadProject(project).slug, node) : previewInfo().url;
    return text({ url, ...maybeOpen(url, { force: true }) });
  });

  tool('canvas_wait_feedback',
    'Wait for the user to act on the canvas (Superdesign-style): Iterate on a frame, select an element and describe a change, ask for N variations, or choose a design. Returns the queued requests (and marks them in progress on the canvas), or an empty list on timeout. Opens the canvas if nobody is viewing it. Handle each request with design_write (parent = request node) and then feedback_resolve.',
    {
      project: z.string(),
      timeout_s: z.number().int().min(5).max(1800).default(240),
    },
    async ({ project, timeout_s }, extra) => {
      if (worker) throw new Error('Not available in a background Claude Code run: handle the requests in your prompt, resolve them with feedback_resolve, then finish.');
      const p = ws.loadProject(project);
      let opened = null;
      if (!viewersOf(p.slug) && config.openMode !== 'never') opened = maybeOpen(projectUrl(p.slug));
      setWaiting(p.slug, +1);
      const token = extra?._meta?.progressToken;
      let ticks = 0;
      const keepAlive = token !== undefined ? setInterval(() => {
        ticks++;
        extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ticks, message: 'waiting for canvas feedback' } }).catch(() => {});
      }, 15000) : null;
      let requests;
      try { requests = await ws.waitForRequests(p.slug, timeout_s * 1000, extra?.signal); }
      finally { setWaiting(p.slug, -1); if (keepAlive) clearInterval(keepAlive); }
      const fresh = ws.loadProject(p.slug);
      if (!requests.length) return text({ requests: [], note: `No feedback within ${timeout_s}s.`, canvas: projectUrl(p.slug), viewers: viewersOf(p.slug), browserOpened: opened?.opened || false });
      const out = requests.map((r) => {
        const n = r.nodeId ? fresh.nodes.find((x) => x.id === r.nodeId) : null;
        const how = {
          iterate: n ? `Make the change as a new iteration: design_write(parent="${n.id}")` : 'Create a new root design from the brief: design_write(no parent)',
          element: `Change only this element (keep everything else identical) and save as an iteration: design_write(parent="${n?.id}")`,
          variations: `Write ${r.count || 3} distinct variations as siblings: design_write(parent="${n?.id ?? ''}") ×${r.count || 3}${n ? '' : ' (no parent = new directions)'}`,
          pick: `The user chose ${n?.id}. Use it as the base for the next step (set DESIGN.md from it if this was the direction phase).`,
          'next-page': `Create the next page of the flow: design_write(link_from="${n?.id}", link_label="${r.label || '<a short label you choose>'}", no parent)`,
          comment: 'Answer or apply the comment.',
        }[r.type];
        return { id: r.id, type: r.type, text: r.text, count: r.count || undefined, element: r.element || undefined, node: n ? nodeView(fresh, n) : null, how };
      });
      return text({ requests: out, context: ws.pinnedContext(fresh), then: 'After handling, call feedback_resolve(request_ids, reply, result_nodes) and wait again.' });
    });

  tool('canvas_link',
    'Draw (or with remove=true delete) a flow arrow between two designs on the canvas, e.g. login -> dashboard with the button text as label.',
    { project: z.string(), from: z.string(), to: z.string(), label: z.string().optional(), remove: z.boolean().optional() },
    async ({ project, from, to, label, remove }) => {
      if (!remove) return text({ edge: ws.addEdge(project, { from, to, label }) });
      const e = ws.loadProject(project).edges.find((x) => x.from === from && x.to === to);
      if (!e) throw new Error(`No edge ${from} -> ${to}.`);
      return text({ removed: ws.deleteEdge(project, e.id) });
    });

  tool('canvas_note',
    'Create, edit or delete a sticky note on the canvas. Pinned notes are product context that every later design must follow (returned as `context` by project_get). No id = create (near=<node> places it beside that design); id = patch, or delete with remove=true.',
    {
      project: z.string(), id: z.string().optional(), text: z.string().optional(), pinned: z.boolean().optional(),
      color: z.string().optional().describe(`One of ${ws.NOTE_COLORS.join(', ')}`), near: z.string().optional(), remove: z.boolean().optional(),
    },
    async ({ project, id, text: body, pinned, color, near, remove }) => {
      if (id && remove) return text({ note: ws.deleteNote(project, id) });
      if (id) return text({ note: ws.updateNote(project, id, { text: body, pinned, color }) });
      const n = near ? ws.getNode(ws.loadProject(project), near) : null;
      const pos = n?.pos ? { x: n.pos.x + (ws.VIEWPORTS[n.viewport] || ws.VIEWPORTS.desktop).width + 48, y: n.pos.y } : null;
      return text({ note: ws.addNote(project, { text: body, pinned, color, pos }) });
    });

  tool('feedback_resolve',
    'Mark canvas requests as done (or dismissed) with a short reply the user sees on the canvas, linking the nodes you produced.',
    {
      project: z.string(),
      request_ids: z.array(z.string()).min(1),
      reply: z.string().default(''),
      result_nodes: z.array(z.string()).default([]),
      status: z.enum(['done', 'dismissed']).default('done'),
    },
    async ({ project, request_ids, reply, result_nodes, status }) => {
      const done = ws.resolveRequests(project, request_ids, { status, reply, resultNodes: result_nodes });
      return text({ resolved: done });
    });

  // =====================================================================
  // Rendering checks & critique
  // =====================================================================
  tool('design_screenshot',
    'Render a design in a headless browser and return screenshots (so you can see the actual result, not only the code). Default viewports: desktop and mobile.',
    {
      project: z.string(), node: z.string(),
      viewports: z.array(z.enum(['desktop', 'tablet', 'mobile'])).default(['desktop', 'mobile']),
      max_height: z.number().int().min(400).max(8000).default(2600),
    },
    async ({ project, node, viewports, max_height }) => {
      const p = ws.loadProject(project);
      const n = ws.getNode(p, node);
      const content = [];
      for (const vp of viewports) {
        const shot = await render.screenshot(nodeUrl(p.slug, n), vp, { maxHeight: max_height });
        content.push({ type: 'text', text: `${n.id} @ ${vp} ${shot.width}×${shot.height}${shot.truncated ? ` (page is ${shot.fullHeight}px, cropped)` : ''}` });
        content.push({ type: 'image', data: shot.buffer.toString('base64'), mimeType: 'image/jpeg' });
      }
      return { content };
    });

  tool('design_lint',
    'Check a design: static source checks + rendered checks in a headless browser (console errors, broken images, horizontal overflow, WCAG contrast, tiny text, 44px tap targets on mobile, alt text) + OpenDesign anti-AI-slop rules (default indigo, emoji icons, left-border cards, purple-blue hero gradient, filler copy, invented metrics, placeholder CDNs, raw hex) + huashu\'s "default Claude look". P0 = fix before ready.',
    {
      project: z.string(), node: z.string(),
      viewports: z.array(z.enum(['desktop', 'tablet', 'mobile'])).default(['desktop', 'mobile']),
      huashu: z.boolean().default(false).describe('Also run huashu-design scripts/design_lint.py (needs python playwright)'),
    },
    async ({ project, node, viewports, huashu }) => {
      const p = ws.loadProject(project);
      const n = ws.getNode(p, node);
      const html = fs.readFileSync(ws.nodeFile(p.slug, n), 'utf8');
      const results = [];
      for (const vp of viewports) results.push(await render.lint({ html, url: nodeUrl(p.slug, n), viewport: vp }));
      let huashuOut = null;
      if (huashu) { try { huashuOut = await render.runHuashuLint([ws.nodeFile(p.slug, n)], await uipro.findPython()); } catch (e) { huashuOut = `huashu lint unavailable: ${e.message}`; } }
      return text({ node: n.id, results, huashu: huashuOut });
    });

  const scoreSchema = z.object({ score: z.number().min(0).max(10), evidence: z.string().min(10).describe('Cite concrete elements/sections; no "feels off"') });
  tool('critique_save',
    'Save a 5-dimension critique (OpenDesign/huashu rubric) for a design and render it as a report linked on the canvas. Dimensions: philosophy (one direction held through every detail), hierarchy (what to read 1st/2nd/3rd), detail (alignment, spacing, polish), functionality (does it do its job, edge cases, mobile), innovation (one memorable, earned move). Bands: 0–4 Broken, 5–6 Functional, 7–8 Strong, 9–10 Exceptional. Score the worst sustained band, cite evidence, don\'t grade-inflate (mean > 8 is suspicious). Base it on design_screenshot + design_lint.',
    {
      project: z.string(), node: z.string(),
      verdict: z.string().describe('One line'),
      scores: z.object({ philosophy: scoreSchema, hierarchy: scoreSchema, detail: scoreSchema, functionality: scoreSchema, innovation: scoreSchema }),
      keep: z.array(z.string()).default([]),
      fix: z.array(z.string()).default([]).describe('Ordered by visual cost saved per minute spent'),
      quick_wins: z.array(z.string()).default([]),
    },
    async ({ project, node, verdict, scores, keep, fix, quick_wins }) => {
      const c = ws.addCritique(project, node, { verdict, scores, keep, fix, quickWins: quick_wins });
      const vals = Object.values(scores).map((s) => s.score);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const warnings = [];
      if (mean > 8) warnings.push('Mean above 8 — likely grade inflation; re-check the weakest dimension.');
      if (Math.min(...vals) >= 7 && fix.length === 0) warnings.push('No Fix items although every score is 7+: list at least the top 3 issues.');
      return text({ critique: c.id, mean: Math.round(mean * 10) / 10, report: critiqueUrl(ws.loadProject(project).slug, c.id), warnings, next: fix.length ? 'Apply the Fix list as a new iteration (design_write parent=node).' : 'Ready for user review.' });
    });

  // =====================================================================
  // Handoff
  // =====================================================================
  tool('handoff',
    'Package the chosen design for implementation in code: copies the HTML, DESIGN.md and tokens into <project>/handoff/<node>/ and writes HANDOFF.md with an implementation brief (plus UI UX Pro Max stack rules if stack is given). Returns the brief.',
    { project: z.string(), node: z.string().optional(), stack: z.string().optional().describe('e.g. nextjs, react, vue, svelte, swiftui, flutter, html-tailwind, shadcn') },
    async ({ project, node, stack }) => {
      const p = ws.loadProject(project);
      const n = ws.getNode(p, node || p.selected || p.nodes[p.nodes.length - 1]?.id);
      const dir = path.join(ws.projectDir(p.slug), 'handoff', n.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(ws.nodeFile(p.slug, n), path.join(dir, 'design.html'));
      const files = ['design.html'];
      for (const f of ['DESIGN.md', 'tokens.css', 'tailwind-v4.css', 'design-tokens.json']) {
        const src = path.join(ws.projectDir(p.slug), f);
        if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, f)); files.push(f); }
      }
      let stackRules = '';
      if (stack) { try { await needSources(); stackRules = await uipro.styleSearch({ query: `${p.brief || p.name} components layout`, stack, maxResults: 6 }); } catch (e) { stackRules = `(stack rules unavailable: ${e.message})`; } }
      const crit = [...p.critiques].reverse().find((c) => c.nodeId === n.id);
      const brief = `# Handoff: ${p.name} — ${n.label}

  Implement \`design.html\` in ${stack || 'the project\'s stack'} as production code.

  - Source of truth for tokens: \`DESIGN.md\`${files.includes('tokens.css') ? ' and `tokens.css`' : ''}. Map them to the project's theme (CSS variables / Tailwind theme) — do not hard-code hex values.
  - Match layout, spacing, type scale and states from \`design.html\`; it is a visual reference, not code to paste.
  - Build reusable components for repeated blocks; keep sections identifiable by their \`data-od-id\` names.
  - Keep accessibility from the design: contrast, focus states, 44px tap targets, alt text, reduced motion.
  - Brief: ${p.brief || '—'}
  ${crit ? `\n## Open fixes from the last critique\n${(crit.fix || []).map((f) => `- ${f}`).join('\n') || '- none'}\n` : ''}
  ${stackRules ? `\n## ${stack} rules (UI UX Pro Max)\n${stackRules}\n` : ''}`;
      fs.writeFileSync(path.join(dir, 'HANDOFF.md'), brief);
      files.push('HANDOFF.md');
      return text({ dir, files, brief });
    });

  // =====================================================================
  // Prompts (show up as slash commands in Claude Code)
  // =====================================================================
  server.registerPrompt('design', {
    description: 'Start a new design with Design Hub (direction → canvas → iterate)',
    argsSchema: { brief: z.string().describe('What to design') },
  }, ({ brief }) => ({ messages: [{ role: 'user', content: { type: 'text', text: DESIGN_PROMPT(brief) } }] }));

  server.registerPrompt('iterate', {
    description: 'Listen to the Design Hub canvas and apply the requests you send from the browser',
    argsSchema: { project: z.string().describe('Project slug (see project_list)') },
  }, ({ project }) => ({ messages: [{ role: 'user', content: { type: 'text', text: ITERATE_PROMPT(project) } }] }));


  return server;
}
