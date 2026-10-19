---
name: design
description: Design UI with Design Hub — landing pages, app screens, dashboards, mobile apps, slides, design systems. Use when the user asks to design, redesign, mock up or prototype an interface, or to pick a visual direction or design system. Runs the full loop on the Design Hub canvas (directions → build → lint → critique → iterate with the user in the browser).
argument-hint: "[what to design]"
---

# Design with Design Hub

The user wants a design: $ARGUMENTS

Use the **design-hub** MCP tools for all of it. Everything you make goes onto the Design Hub canvas (a local web page the user watches), not into chat.

1. Call `hub_workflow` first and follow it. It says which source owns which decision (UI UX Pro Max picks the style, huashu-design shows directions, DESIGN.md holds tokens, OpenDesign templates give layout and craft rules) and the conflict rules between them.
2. If the user is iterating on something that exists, find it with `project_list` / `project_get`; otherwise `project_create` with a short name and a brief written from the request. If they named a brand or a known product look, pass `design_system` (find it with `catalog_search kind=systems`).
3. Direction phase (skip if DESIGN.md exists and the user asked for a specific screen): `style_design_system` → three genuinely different roots with `design_write` → `design_status review` → `canvas_wait_feedback` so the user picks on the canvas. Turn the pick into DESIGN.md with `design_md_set`.
4. Build from the matching template (`catalog_search kind=templates`, `catalog_get` — it brings its craft rules). One self-contained HTML file per design, tokens from DESIGN.md, real copy, SVG icons.
5. `design_lint` (desktop + mobile) and `design_screenshot`; fix every P0. Critique as a separate step and save it with `critique_save`, then apply its Fix list as a new iteration.
6. Iterate: `design_status review`, then loop `canvas_wait_feedback` → `design_write` (parent = the request's node) → `feedback_resolve`. Stop when the user marks the design ready or says stop; `design_status ready` opens the chosen design in their browser.
7. If they want it in code, `handoff` with their stack, then implement.

Reply to the user in their language. Keep chat short — point them to the canvas.
