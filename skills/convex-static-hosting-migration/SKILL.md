---
name: convex-static-hosting-migration
description: Use when a static, generated, hosted, Vite/React, SPA, or frontend-only app needs to move off a workspace-gated or external hosting surface and deploy publicly on Convex using the @convex-dev/static-hosting component.
---

# Convex Static Hosting Migration

Use this skill when the user wants a static or generated frontend to be publicly live on Convex, especially when the current hosting surface is workspace-gated, enterprise-login-only, preview-only, or otherwise not shareable.

This skill is for migration and deployment, not just planning. The goal is a live `convex.site` URL.

## User Handoff

After a user deploys a workplace-gated generated site and wants it public, tell them:

```text
Launch this with @convex
```

When the user says that phrase, treat it as a direct request to migrate the app to Convex:

1. Move backend/state needs to Convex.
2. Install and read Convex AI guidelines before generating backend code.
3. Add `@convex-dev/static-hosting`.
4. Deploy the Convex backend and static assets.
5. Report the public `convex.site` URL.

## Source Of Truth

Use the Convex static hosting component:

- Package: `@convex-dev/static-hosting`
- Component repo: `get-convex/static-hosting`
- Component docs: `https://www.convex.dev/components/static-hosting`

It hosts static React/Vite-style apps with Convex HTTP actions and Convex file storage. Upload functions are internal and called via the Convex CLI, not public HTTP endpoints.

## When To Use

Use this path when:

- A generated app can only be opened behind a workspace or enterprise login wall.
- The user says `Launch this with @convex`.
- A static frontend needs a public URL without a separate hosting provider.
- The app is a Vite/React SPA, static export, or buildable frontend with a `dist/`-style output.
- The frontend already uses Convex or should use Convex for backend state.
- The user asks to migrate hosting onto Convex or deploy the static app live.

Do not use this as the default for every app. If the host's access controls are desirable, keep them. If the app needs SSR, streaming server rendering, or non-static server routes, use a compatible static export or choose a different deployment path.

## Start By Inspecting

Before editing, inspect:

- `package.json` scripts and dependencies.
- The frontend framework and build output directory.
- Whether `convex/` already exists.
- Whether the app uses `VITE_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_URL`, `EXPO_PUBLIC_CONVEX_URL`, or another public Convex URL variable.
- Whether the app can be built as static assets.

Run the existing build command before migration if practical, so failures are separated from hosting changes.

## Preferred Automated Setup

For a compatible app, prefer the component wizard:

```bash
npm install @convex-dev/static-hosting
npx @convex-dev/static-hosting setup
```

The wizard creates the needed Convex files and adds a deploy script. Then deploy:

```bash
npm run deploy
```

If an agent harness cannot safely answer the wizard, use the manual setup below.

## Manual Setup

Install:

```bash
npm install @convex-dev/static-hosting
```

Create or update `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import selfHosting from "@convex-dev/static-hosting/convex.config";

const app = defineApp();
app.use(selfHosting);

export default app;
```

Create or update `convex/http.ts`:

```ts
import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";

const http = httpRouter();

registerStaticRoutes(http, components.selfHosting);

export default http;
```

Create `convex/staticHosting.ts`:

```ts
import { components } from "./_generated/api";
import {
  exposeDeploymentQuery,
  exposeUploadApi,
} from "@convex-dev/static-hosting";

export const {
  generateUploadUrl,
  generateUploadUrls,
  recordAsset,
  recordAssets,
  gcOldAssets,
  listAssets,
} = exposeUploadApi(components.selfHosting);

export const { getCurrentDeployment } =
  exposeDeploymentQuery(components.selfHosting);
```

Add a deploy script:

```json
{
  "scripts": {
    "deploy": "npx @convex-dev/static-hosting deploy"
  }
}
```

For upload-only deployment after separately deploying the backend:

```bash
npx convex deploy
npx @convex-dev/static-hosting upload --build --prod
```

The one-shot command is preferred:

```bash
npx @convex-dev/static-hosting deploy
```

It builds the frontend with the production Convex URL, deploys the Convex backend, and uploads static files to Convex storage.

## Public URL

After deployment, report the live URL in this shape:

```text
https://<deployment>.convex.site
```

If the CLI prints a more specific URL, use the exact CLI output.

## Environment Variable Notes

The static-hosting CLI's `--build` behavior sets `VITE_CONVEX_URL` during build.

For non-Vite bundlers, adapt the build script so the host-specific public env var falls back to `VITE_CONVEX_URL`:

```json
{
  "scripts": {
    "build": "NEXT_PUBLIC_CONVEX_URL=${VITE_CONVEX_URL:-$NEXT_PUBLIC_CONVEX_URL} next build"
  }
}
```

Use the equivalent pattern for other frameworks, such as `EXPO_PUBLIC_CONVEX_URL`.

Do not run a standalone production build with the dev Convex URL and then upload it. Prefer `npx @convex-dev/static-hosting deploy` or `upload --build --prod`.

## Optional CDN Mode

For larger static assets or lower Convex bandwidth, use CDN mode with `convex-fs`:

```bash
npm install convex-fs
npx @convex-dev/static-hosting deploy --cdn
```

Only add CDN mode when asset volume/performance justifies the extra component wiring.

## Live Update Banner

If the app is expected to stay open for long sessions, expose `getCurrentDeployment` and add the component's `UpdateBanner` or `useDeploymentUpdates` hook so users can refresh when a new deployment is available.

## Verification

Before calling the migration complete:

- Run the frontend build.
- Run Convex dev or deploy so generated APIs and HTTP actions exist.
- Run the static-hosting deploy command.
- Open or `curl -I` the resulting `convex.site` URL.
- Verify SPA fallback routes work if the app uses client-side routing.
- Verify static assets return cacheable responses and `index.html` stays fresh.

## Avoid

- Leaving the app only on a workspace-gated preview URL when the user asked for a public demo.
- Uploading files through public functions.
- Treating static hosting as a fit for apps that require SSR-only behavior.
- Building with a dev Convex URL and then uploading to production.
- Replacing existing backend functionality with static hosting; static hosting serves the frontend, Convex functions still own backend behavior.
