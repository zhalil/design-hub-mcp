---
name: update
description: Update Design Hub's design systems, templates, skills and craft rules from their parent repositories (OpenDesign, huashu-design, UI UX Pro Max), or roll the last update back.
argument-hint: "[check | apply | rollback]"
disable-model-invocation: true
---

# Update Design Hub sources

Requested action: $ARGUMENTS (default: check, then ask before applying).

1. `hub_update` with `action: "check"`. Summarize per source: current → latest commit, and per kind (systems, templates, skills, rules, references) what is new, removed or changed. Keep it short.
2. If the user asked to apply, or agrees after the summary: `hub_update` with `action: "apply"`. Report what moved and which installed skills were re-synced.
3. For `rollback`: `hub_update` with `action: "rollback"` and report the commits each source returned to.

This updates the upstream content Design Hub pulls in. The Design Hub plugin itself updates through `/plugin` (marketplace update).
