---
name: add
description: "Add a capability to the CURRENT Convex + Next.js project. Built-in: hosting (publish to *.convex.site via the @convex-dev/static-hosting component). ANYTHING ELSE (email, notifications, billing, search, crons, …) finds + installs the matching Convex component. TRIGGER when the user runs $add, or asks to add hosting/publishing or any backend capability to an existing Convex app. (Auth/passkeys, the feedback panel, and custom domains are de-scoped for this release.)"
license: Apache-2.0
---

# Add a capability ($add <capability>)

The user ran `$add <capability>` (the text after `$add`). Run the matching served
script from the Convex quickstart backend, then finish the project-specific step.
Run from the project root.

```bash
CAP="<capability>"   # hosting | <anything else>
B="https://basic-anteater-667.convex.site"
# feedback / passkeys / domain are de-scoped for this release — they ship later.
case "$CAP" in
  hosting) curl -fsSL "$B/add-$CAP" | bash ;;
  "") echo "ADD_USAGE: /add <hosting|capability>" ;;
  *) curl -fsSL "$B/add-component" | ADD_TERM="$CAP" bash ;;
esac
```

Then finish based on the output:
- **`ADD_HOSTING_DONE`** — wired `@convex-dev/static-hosting`, built + uploaded. If it printed `ADD_HOSTING_URL=` / `https://<deployment>.convex.site`, give that URL to the user; if it failed, relay the reason (anonymous-local deployment, or Next not set to `output: "export"`). *(Interim `*.convex.site` path while the `*.convex.app` gateway is down.)*
- **`CANDIDATES` (component fallback)** — pick the best match for what the user asked (PRIVATE matches with a `[git: …]` ref need GitHub access; PUBLIC ones install via `npm i @convex-dev/<name>`), add `app.use(...)` to `convex/convex.config.ts`, and wire it per the package's README. Don't hardcode a mapping — choose from the live candidates.

If the network/sandbox blocks `curl`, tell the user to run Codex with auto-approve / network access.
