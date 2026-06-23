# Convex Codex Plugin

A Codex plugin for building on Convex: scaffold a running app from one sentence and build it live, add capabilities from the Convex component ecosystem, get a `convex-expert` subagent and a `convex-reviewer`, and watch for runtime errors as you go.

Use this when an app needs a backend: database schema, reactive queries, mutations, server functions, auth-aware data access, real-time features, file storage, scheduled jobs, mobile/web app backends, or production scaling guidance.

## Install (Codex CLI)

```bash
codex plugin marketplace add get-convex/convex-codex-plugin
codex plugin add convex@convex-codex-plugin
```

Then invoke the skills (`quickstart`, `add`, `convex-expert`, `convex-reviewer`, `check-updates`, `quickstart-improve`). The plugin also registers two MCP servers: the official Convex MCP (live-deployment introspection) and an error-watcher.

To update later: `codex plugin marketplace upgrade` then re-run `codex plugin add convex@convex-codex-plugin`.

## ChatGPT app

This plugin points Codex at the reviewed Convex app snapshot:

```text
asdk_app_6a0faef988b48191b843bac5cd170a9e
```

App URL: https://chatgpt.com/apps/convex/asdk_app_6a0faef988b48191b843bac5cd170a9e

The app exposes tools for starting Convex apps, adding Convex to existing JavaScript and TypeScript projects, and getting Convex scaling guidance.

## Example asks

```text
I want to make an app where my friends can vote on movie nights.
Build a real-time chat backend with rooms and message history.
Add sign-in and user-owned tasks to my Next.js app.
Design a multi-tenant schema for a SaaS with workspaces and roles.
What is the simplest way to add real-time updates to my app?
Review my app architecture before launch.
```

## Repo contents

- `.agents/plugins/marketplace.json` - marketplace manifest (makes the plugin installable)
- `plugins/convex/` - the Codex CLI plugin (skills + MCP servers)
- `.codex-plugin/plugin.json` + `.app.json` - the reviewed Convex ChatGPT app (a lighter, coexisting target)
- `assets/` - Convex brand assets

