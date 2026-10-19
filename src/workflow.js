// The orchestration contract: how the pulled-in sources work together without fighting.
export const WORKFLOW = `# Design Hub pipeline

Design Hub combines four upstream sources. Each owns one job; do not let two of them make the same decision.

| Job | Owner | Tools |
|---|---|---|
| Which style fits this product (data) | UI UX Pro Max | style_design_system, style_search |
| Showing directions to choose from | huashu-design | catalog_get huashu-design/huashu-design (+ its references/directions.md) |
| Brand contract | DESIGN.md (OpenDesign format) | catalog_search kind=systems, design_md_set |
| Layout blueprint per output type | OpenDesign templates (+ their craft rules) | catalog_search kind=templates, catalog_get |
| Review | critique rubric (OpenDesign, from huashu) | design_lint, design_screenshot, critique_save |
| Visual iteration with the user | Design Hub canvas (Superdesign-style) | design_write, canvas_wait_feedback, feedback_resolve |

## Conflict rules (always apply)
1. DESIGN.md is the single source of truth for tokens once it exists. Never invent colors or fonts outside it; change DESIGN.md first (design_md_set) if the direction changes.
2. Direction phase happens once per project: UI UX Pro Max narrows to 3 candidates → you render 3 roots on the canvas → the user picks → the pick becomes DESIGN.md. Do not also run OpenDesign's 5-direction picker or huashu's 20-style catalogue as a second chooser.
3. If DESIGN.md already exists (brand given), "3 directions" means 3 variations *inside* the system, not 3 new styles (overrides huashu's "even with a brand" rule).
4. Use one critique: critique_save's 5 dimensions. Run it as a separate explicit step, never in the same breath as generating (ideally in a subagent that did not write the design). Ground it in design_screenshot + design_lint, not only the source.
5. Templates bring their own craft rules (catalog_get returns them). Treat P0 lint findings as must-fix before marking a design ready.
6. Read context (pinned notes) from project_get and follow it. Link the pages of a flow (design_write link_from / canvas_link), and offer to save product logic the user tells you as a pinned note (canvas_note pinned=true).

## Steps
0. **Project.** project_create (name, brief; design_system if the user has a brand or names one). Reuse an existing project when the user is iterating.
1. **Direction** (skip if DESIGN.md exists and the user asked for a specific screen):
   - style_design_system with a query describing product + audience + mood.
   - Read huashu-design's SKILL.md once per session (catalog_get id="huashu-design/huashu-design") for its taste rules and anti-default-look guidance.
   - Write 3 genuinely different roots with design_write (no parent), label them by direction. Then design_status → "review" (opens the canvas) and canvas_wait_feedback so the user can choose or comment.
   - When the user chooses: design_md_set for the chosen direction (adapt an OpenDesign system via from_system, or write content).
2. **Build.** Pick the template that matches the output (catalog_search kind=templates, e.g. saas-landing, dashboard, mobile-app, html-ppt-*). catalog_get it — follow its structure and the rules it pulls in. Write the design as ONE self-contained HTML file: inline CSS/JS, read tokens from DESIGN.md (copy them into :root or link ../tokens.css), real copy (no lorem), SVG icons, <meta name="viewport">. Save with design_write (parent = the chosen root).
3. **Check.** design_lint (desktop + mobile) and design_screenshot. Fix every P0. Then critique (rule 4) and save it with critique_save; apply the Fix list as a new iteration.
4. **Iterate with the user.** design_status "review", then loop: canvas_wait_feedback → do each request → design_write (parent = request.nodeId; for "element" requests change only that element; for "variations" write N siblings with the same parent; for "next-page" design_write with link_from = request.nodeId and no parent) → feedback_resolve with a one-line reply and the new node ids. Stop when the user marks the project ready or says stop.
5. **Ready & handoff.** design_status "ready" (opens the browser on the chosen design). If code is wanted: handoff → implement in the user's stack (style_search with stack=… for stack rules).

## Writing a design file
- Size frames to the viewport you pass to design_write (mobile 390, tablet 820, desktop 1440).
- Mark major sections with data-od-id="hero" etc. so element requests have stable selectors.
- Keep each node a complete page; never write partial diffs into design_write. For small fixes you may Edit the node file in place (path returned by design_write) — the canvas live-reloads.
- Respond to the user in their language.
`;

export const ITERATE_PROMPT = (slug) => `Run the Design Hub feedback loop for project "${slug}".
1. Call project_get to see the canvas tree and any queued requests.
2. Loop: canvas_wait_feedback (project "${slug}") → handle every request it returns (design_write with parent = request.nodeId; "element" = change only that element; "variations" = N siblings) → feedback_resolve with a short reply and the new node ids.
3. If canvas_wait_feedback returns nothing twice in a row, ask me whether to keep listening.
Follow the conflict rules from hub_workflow (DESIGN.md is the source of truth for tokens).`;

export const DESIGN_PROMPT = (brief) => `Design this with the design-hub MCP: ${brief}

First call hub_workflow and follow its pipeline: create a project, run the direction phase (3 roots on the canvas), let me choose on the canvas, then build, lint, critique and iterate with me through canvas_wait_feedback.`;
