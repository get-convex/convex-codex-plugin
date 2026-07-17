# OpenAI curated-registry submission — Convex Codex plugin

**Status: users are broken.** OpenAI's curated registry (and the ChatGPT-app
install path) serves a **v0.1.2 empty husk** of this plugin: zero skills, zero
MCP servers, just a capability blurb. Everything real — 17 skills, both MCP
servers, the whole plugin — has only ever lived on GitHub. A user who installs
`convex` from the curated source gets nothing functional.

This doc is the package to fix that. It's the thing to push through OpenAI so the
curated build stops being a husk.

## The one-line summary

Update the bundled `convex` plugin snapshot in OpenAI's curated marketplace from
**v0.1.2 → the current published version** (see
`plugins/convex/.codex-plugin/plugin.json`). Same app, same declared interface —
just the real payload instead of the empty one.

## Why this is (probably) lighter than a full app re-review

The **declared ChatGPT-app interface is unchanged** between the husk and current:

| Interface field | v0.1.2 (husk, live) | current (this repo) |
|---|---|---|
| app id | `asdk_app_6a0faef988b48191b843bac5cd170a9e` | same |
| `interface.capabilities` | 10 items | **identical 10 items** |
| `interface.defaultPrompt` | 3 prompts | **identical 3 prompts** |
| `interface.websiteURL` | `chatgpt.com/apps/convex/asdk_app_6a0…` | same |

What actually differs is the **Codex-CLI plugin payload** that the curated
marketplace bundles at `./plugins/convex` and serves as `source: local`:

| Payload | v0.1.2 (husk, live) | current (this repo) |
|---|---|---|
| skills | **0** | **17**: add, agent, auth, billing, check-updates, convex-authz, convex-expert, convex-reviewer, crons, domains, env, labs-quickstart, migrate, quickstart, quickstart-improve, seed, test |
| MCP servers | **none** | **2**: `convex` (official `npx convex mcp start`), `convex-plugin` (local error-watcher) |
| local MCP tools | **none** | `fix_errors_automatically` |

So the ask is: **refresh the bundled plugin snapshot**, not redraw the app's
declared surface. If OpenAI's process still requires a review pass for a payload
this much larger, so be it — but the *app interface* reviewers signed off on has
not moved.

## Pre-submission checklist (verified 2026-07-17, build v0.7.2)

The build is ready — these were checked on `main`:

- [x] Payload `plugins/convex/` is at **v0.7.2**, self-contained (skills + `.mcp.json` + `.codex-plugin/plugin.json` + `.app.json`).
- [x] **17 skills + 2 MCP servers** present; installs clean in an isolated `CODEX_HOME` (`codex plugin add convex@convex-codex-plugin` → root `.../convex/0.7.2`).
- [x] **Zero staging leaks** — no `graceful-tiger-715` (staging) or beta refs in the payload; the review flow points at prod `basic-anteater-667`.
- [x] **Root app-card version aligned** to 0.7.2 (was a stale 0.4.9) so the app listing and payload agree.

## What to submit

1. **The current build of `plugins/convex/`** from `get-convex/convex-codex-plugin`
   at **v0.7.2** (`main`). Self-contained; nothing else needs to be assembled.
2. Against app **`asdk_app_6a0faef988b48191b843bac5cd170a9e`** — the account that
   owns this app drives the submission via the OpenAI Apps developer console (it
   cannot be done from the `codex` CLI, which has only `add`/`list`/`marketplace`;
   there is no `codex publish`).
3. **Reviewer note (paste verbatim):** "Payload refresh only. The declared app
   interface (capabilities, defaultPrompt, websiteURL) is unchanged from the
   currently-live v0.1.2. This adds the plugin's 17 skills and two MCP servers (one
   official Convex MCP `npx convex mcp start`, one local Node error-watcher exposing
   `fix_errors_automatically`). No new declared capabilities; no change to the app
   card copy."

## Two possible channels (confirm which one OpenAI uses for this app)

- **A — ChatGPT app-developer console re-submit.** Push a new build of the app;
  OpenAI reviews + publishes. Standard path, needs the app owner's login.
- **B — Curated-marketplace PR.** The local curated cache shows PR-style history
  (e.g. `#380`). If OpenAI's curated registry accepts external PRs to update a
  bundled snapshot, that may be faster than A. **Action:** find the upstream repo
  behind the `openai-curated` marketplace and check its contribution policy; the
  local cache at `~/.codex/.tmp/plugins` had no configured remote, so this needs
  an OpenAI-side contact to confirm.

## After OpenAI publishes it — close the loop (don't skip this)

1. Verify a **fresh** install actually serves the new version:
   ```bash
   codex plugin marketplace update            # or remove+re-add openai-curated
   codex plugin add convex@openai-curated
   codex plugin list | grep openai-curated    # must show the NEW version + non-empty skills
   ```
2. Only then, re-baseline the drift gate so it goes green honestly:
   ```bash
   node scripts/codex-review-gate.mjs --accept --i-really-submitted-to-openai
   git add plugins/convex/.codex-review.json && git commit -m "codex: record published surface after OpenAI refresh"
   ```

## How this hid for so long (and why it can't again)

The drift gate (`scripts/codex-review-gate.mjs`) had been `--accept`'d at v0.6.0 —
recording a GitHub surface as "submitted" while OpenAI never published past v0.1.2.
That made the gate green while users kept getting the husk. The gate's baseline
(`plugins/convex/.codex-review.json`) now records **what OpenAI actually serves**
(verified from a live install), and `--accept` refuses to move it without an
explicit `--i-really-submitted-to-openai` acknowledgement. So CI now reads:

> ✗ CODEX DISTRIBUTION LAG — users install an OLDER build than this repo.

and will keep reading that until a real submission lands. That red is correct: it
is the honest state of the world until the curated build is refreshed.

## Interim: the install that works today

Until the curated build is refreshed, the working install (documented in the
README) is the GitHub marketplace, which always serves this repo's HEAD:

```bash
codex plugin marketplace add get-convex/convex-codex-plugin
codex plugin add convex@convex-codex-plugin
```
