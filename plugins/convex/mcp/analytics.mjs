#!/usr/bin/env node
// Dependency-free PostHog telemetry for the plugin's MCP server. A direct
// port of the Claude plugin's hooks/analytics.mjs (get-convex/
// convex-backend-skill) so both surfaces emit the SAME event names with the
// SAME privacy gates to the SAME PostHog project — differing only in the
// `harness` property ("codex" here, "claude" there).
//
// Design notes:
// - NEVER delays or breaks the server. `capture()` spawns
//   `node analytics.mjs --emit <base64 payload>` as a DETACHED child
//   (stdio ignored, .unref()'d) and returns immediately; the child completes
//   the POST on its own (3s abort timeout, every error swallowed, always
//   exits 0). stdout stays untouched — it is reserved for MCP protocol.
// - On-by-default, with explicit opt-outs checked before anything else:
//     * The public write-only PostHog project key (phc_…, the same one the
//       Convex dashboard ships in its committed .env files) is baked in as the
//       default, so telemetry works out of the box. Override or blank it with
//       CONVEX_PLUGIN_POSTHOG_KEY; a blank key fully disables sending.
//     * CONVEX_PLUGIN_TELEMETRY === "0" → disabled (explicit opt-out).
//     * DO_NOT_TRACK is "1"/"true" → disabled (ecosystem convention).
// - Privacy: NO code contents, file paths, prompts, or user identifiers ever
//   go into event properties. Only an anonymous random device id
//   (~/.convex/plugin-device-id — shared with the Claude plugin, so one
//   machine is one device across harnesses), the plugin version, OS
//   platform, the fixed harness tag ("codex"), and locally-derived booleans
//   (e.g. convex_project). snake_case event names.
// - Any filesystem failure (unwritable home dir, missing plugin.json) falls
//   back silently — telemetry must never surface an error to the server.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Public, write-only PostHog project key (client-side `phc_` token, safe to
// commit — it can only ingest events, not read them). Same key the Convex
// dashboard and the Claude plugin ship. Override via env, or set it to an
// empty string to disable telemetry entirely.
const DEFAULT_POSTHOG_KEY = "phc_JDNTRxeh2li2sQTRO0IcOYMJcp8fPs5nTK9TU751nQK";
const POSTHOG_KEY = process.env.CONVEX_PLUGIN_POSTHOG_KEY ?? DEFAULT_POSTHOG_KEY;
const POSTHOG_HOST =
  process.env.CONVEX_PLUGIN_POSTHOG_HOST ?? "https://us.i.posthog.com";

// Which agent surface emits these events. The Convex plugins for other
// harnesses (Claude, …) send the same event names to the same project, so
// every event carries a `harness` discriminator — same vocabulary as the
// `harness` standard property in convex-agents POSTHOG.md §3
// (claude | codex | cursor | …). This plugin is the Codex surface.
const HARNESS = "codex";

function isDisabled() {
  if (!POSTHOG_KEY) return true;
  if (process.env.CONVEX_PLUGIN_TELEMETRY === "0") return true;
  const dnt = (process.env.DO_NOT_TRACK ?? "").toLowerCase();
  if (dnt === "1" || dnt === "true") return true;
  return false;
}

// Stable anonymous device id. Created once at ~/.convex/plugin-device-id
// (mode 0600); if the dir/file is unreadable or unwritable, fall back to
// "anonymous" rather than erroring.
function deviceId() {
  try {
    const file = join(homedir(), ".convex", "plugin-device-id");
    try {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return existing;
    } catch {
      // Missing — fall through and create it.
    }
    const id = randomUUID();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
    return id;
  } catch {
    return "anonymous";
  }
}

// Plugin version, read lazily from ../.codex-plugin/plugin.json relative to
// this script so it works wherever the plugin is installed.
function pluginVersion() {
  try {
    const manifest = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      ".codex-plugin",
      "plugin.json",
    );
    const version = JSON.parse(readFileSync(manifest, "utf8")).version;
    return typeof version === "string" && version ? version : "unknown";
  } catch {
    return "unknown";
  }
}

// Cheap, local-only probe: does `dir` look like a Convex project? Used to
// attach a `convex_project: true|false` boolean to session events so
// installed-base sessions can be split from sessions doing actual Convex
// work. Only the boolean ever leaves the machine — never the path. Any fs
// error (missing dir, no permission) counts as "not a Convex project".
export function isConvexProject(dir) {
  if (typeof dir !== "string" || !dir) return false;
  try {
    if (statSync(join(dir, "convex")).isDirectory()) return true;
  } catch {
    // no convex/ dir — keep probing
  }
  try {
    if (statSync(join(dir, "convex.json")).isFile()) return true;
  } catch {
    // no convex.json — keep probing
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg?.dependencies?.convex || pkg?.devDependencies?.convex) return true;
  } catch {
    // no readable package.json
  }
  return false;
}

// Fire-and-forget event capture. Safe to call from any server path: a no-op
// when telemetry is disabled, and otherwise returns immediately after
// spawning the detached emitter child. Never throws.
export function capture(event, properties = {}) {
  try {
    if (isDisabled()) return;
    const body = {
      api_key: POSTHOG_KEY,
      event,
      distinct_id: deviceId(),
      properties: {
        ...properties,
        harness: HARNESS,
        plugin_version: pluginVersion(),
        $process_person_profile: false,
      },
    };
    const payload = Buffer.from(
      JSON.stringify({ host: POSTHOG_HOST, body }),
    ).toString("base64");
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--emit", payload],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  } catch {
    // Telemetry must never change server behavior.
  }
}

// Child entrypoint: `node analytics.mjs --emit <base64 payload>` decodes the
// payload and performs the actual POST, bounded by a 3s abort timeout. All
// errors are swallowed; always exits 0.
if (process.argv[2] === "--emit") {
  (async () => {
    try {
      const { host, body } = JSON.parse(
        Buffer.from(process.argv[3] ?? "", "base64").toString("utf8"),
      );
      await fetch(`${host}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // ignore — telemetry is best-effort
    }
    process.exit(0);
  })();
}
