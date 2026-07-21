# OpenAI distribution — how the Convex surfaces actually update

> **Correction (2026-07-21):** an earlier version of this doc assumed OpenAI ingests
> an uploaded build or pulls `plugins/convex/` from GitHub. **That is wrong.** There
> are **two separate OpenAI surfaces**, and neither works that way. This rewrite
> documents the real mechanisms so we don't chase the wrong fix again.

## The two surfaces (do not conflate them)

| Surface | What it is | Update mechanism |
|---|---|---|
| **A. ChatGPT app** `asdk_app_6a0faef988b48191b843bac5cd170a9e` ("Convex", shows ~v2.0.0 in ChatGPT) | A **live hosted MCP server** = **`mcp.convex.dev`** (`get-convex/openai-mcp`, Vercel). Its "tools" (`start_convex_app`, `get_runbook`, `add_convex_to_existing_project`, `get_scaling_guidance`, + Tier-2 `publish_app`/`register_domain`/`query_prod_errors`) ARE the app. | **platform.openai.com/plugins** (needs `api.apps.write`): new **draft** of the existing app → **scan the live MCP endpoint** → release notes → submit for review → publish. OpenAI connects to the live endpoint; it does **not** take an upload or a repo. |
| **B. Codex-CLI curated plugin** `convex@openai-curated` (v0.1.2 husk, 0 skills) | A bundled **Codex CLI plugin** snapshot in OpenAI's **curated marketplace** (a different distribution channel from the Apps SDK). | **Unconfirmed / OpenAI-internal.** The curated marketplace has no public PR path we've found. Whether the Apps-SDK app submission (A) also refreshes this bundle, or it's a separate curation, is **not verified**. |

This repo (`plugins/convex/`, currently **v0.7.2**, 17 skills + 2 MCP servers) is the
source for surface B and for the **GitHub-marketplace** install below. It is **not**
what backs surface A — that's the `mcp.convex.dev` MCP server in `get-convex/openai-mcp`.

## Surface A — updating the ChatGPT app (the confirmed path)

The big lever: **the MCP tools serve their content LIVE.** Refreshing what a tool
returns (e.g. the runbook behind `get_runbook`) reaches **every user, any app version,
on their next call — with no reconnect and no re-review** (only the tool *surface* is
reviewed, not the content). That content refresh happens in `get-convex/openai-mcp`
(e.g. `npm run sync:runbook` → deploy), independent of any OpenAI submission.

A **re-submission** is only needed to catch the *reviewed surface* up (the reviewed
app is ~v2.0.0, behind the live 7-tool server). To do it without breaking existing
users:
- **Never rename or remove a tool** — existing users reference them by name.
- **Never add a REQUIRED scope.** The spend scopes (`deploy`/`domains`/`billing`) use
  **call-time consent** (`lib/oauth/scopes.ts` `needsCallTimeReconsent` + the
  `auth_required` handshake), so base tools work without them. The app's "not all
  permissions granted — reconnect" notice is informational, not a hard break.
- Steps: platform.openai.com/plugins → new draft → scan `mcp.convex.dev` → release
  notes ("added publish/domain/prod-error tools with call-time consent; refreshed
  runbook") → submit → publish after approval.

## Surface B — the Codex-CLI curated husk (still unresolved)

Installing `convex@openai-curated` from Codex gives the **v0.1.2 husk** (0 skills, no
MCP). We have **not** confirmed how OpenAI refreshes that curated bundle — the curated
marketplace is OpenAI-internal with no public PR path, and it's unclear whether it's
driven by the same app id as surface A or a separate pipeline. **This is the open item
to resolve with an OpenAI contact**, not something we can fix from this repo.

## Interim: the install that works today (surface-independent)

The **GitHub marketplace** always serves this repo's HEAD (v0.7.2, full plugin):

```bash
codex plugin marketplace add get-convex/convex-codex-plugin
codex plugin add convex@convex-codex-plugin
```

Point users here until the curated bundle (B) is resolved. (Verified: installs clean
in an isolated `CODEX_HOME`, 17 skills + 2 MCP servers, no staging leaks.)

## The drift gate (`scripts/codex-review-gate.mjs`)

Still valid for tracking whether **this repo's** surface has moved past what's
published — it reads `plugins/convex/.codex-review.json` (the last-published baseline)
and warns on drift. Note its baseline concerns surface B (the codex plugin bundle),
which remains at the v0.1.2 husk until B's update path is resolved.
