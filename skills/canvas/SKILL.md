---
name: canvas
description: Listen to the Design Hub canvas and apply what the user sends from the browser (iterate on a frame, change a selected element, N variations, choose a design). Use when the user says to check, watch or listen to the design canvas, or that they left requests there.
argument-hint: "[project]"
---

# Work through the Design Hub canvas

Project: $ARGUMENTS (if empty, call `project_list` and take the most recently updated project, or ask if it is unclear).

1. `project_get` to see the canvas tree, DESIGN.md and any queued requests.
2. Loop:
   - `canvas_wait_feedback` for the project (it opens the canvas if the user doesn't have it open).
   - For every request it returns: read the target node's file, then `design_write` with `parent` = the request's node and `request_id`:
     - **element** — change only that element (selector given), leave everything else identical;
     - **iterate** — apply the change to the whole design (no node = a new root from the brief);
     - **variations** — write N distinct siblings with the same parent;
     - **pick** — the user chose that node; if there is no DESIGN.md yet, write one for it with `design_md_set`.
   - `design_lint` the new node and fix P0 issues you introduced.
   - `feedback_resolve` with the new node ids and a one-sentence reply in the user's language.
3. If `canvas_wait_feedback` comes back empty twice in a row, ask the user whether to keep listening.

DESIGN.md is the only source of tokens. Don't invent colors or fonts outside it.
