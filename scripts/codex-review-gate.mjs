#!/usr/bin/env node
// codex-review-gate.mjs — force a fresh ChatGPT-app submission when the Codex
// plugin's *reviewable surface* changes.
//
// The public Convex Codex app is a REVIEWED ChatGPT app: adding/removing an MCP
// tool or a skill (or changing the app's declared capabilities) is a material
// change that must go through re-review before it reaches users. It's easy to
// ship such a change and forget to re-submit. This gate makes that impossible to
// miss: it fingerprints the reviewable surface and fails if it drifted from the
// last surface you recorded as submitted-for-review.
//
//   node scripts/codex-review-gate.mjs            # check (CI + pre-deploy); exit 1 on drift
//   node scripts/codex-review-gate.mjs --accept   # record the CURRENT surface as reviewed
//                                                  # (run AFTER you submit the new build)
//   node scripts/codex-review-gate.mjs --print    # print the current surface + fingerprint
//
// Workflow when the gate fails:
//   1. Submit the new build to the ChatGPT app review (the app in .app.json).
//   2. Once accepted, run `--accept` to update plugins/convex/.codex-review.json.
//   3. Commit that baseline alongside the change; the gate goes green.
//
// What's fingerprinted (things that gate app review, and that we control here):
//   • skills            — the skill folder names under plugins/convex/skills
//   • mcpServers        — the server set in .mcp.json (name → command/args)
//   • localMcpTools     — tool names exposed by LOCAL node MCP servers (parsed)
//   • app.capabilities  — interface.capabilities in the plugin manifest
//   • app.defaultPrompt — interface.defaultPrompt in the plugin manifest
// NOTE: tools from the external `convex` server (`npx convex mcp start`) are
// versioned by the convex package and reviewed there, so they're intentionally
// out of scope here (only the server ENTRY is fingerprinted, not its live tools).

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "plugins", "convex");
const BASELINE = join(PLUGIN, ".codex-review.json");

const fail = (msg) => { console.error(msg); process.exit(1); };
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// ── collect the reviewable surface ──────────────────────────────────────────
function collectSkills() {
  const dir = join(PLUGIN, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory())
    .sort();
}

function collectMcp() {
  const mcpPath = join(PLUGIN, ".mcp.json");
  if (!existsSync(mcpPath)) return { servers: {}, localTools: [] };
  const servers = readJson(mcpPath).mcpServers || {};
  // Canonical server view: name → command + args (so a changed command re-triggers).
  const canonServers = {};
  const localTools = new Set();
  for (const [name, def] of Object.entries(servers)) {
    canonServers[name] = { command: def.command || "", args: def.args || [] };
    // A LOCAL node server (node mcp/foo.mjs) is ours — parse the tool names it bakes.
    if (def.command === "node" && Array.isArray(def.args)) {
      const rel = def.args.find((a) => typeof a === "string" && a.endsWith(".mjs"));
      if (rel) {
        const abs = join(PLUGIN, def.cwd || ".", rel);
        for (const t of parseLocalTools(abs)) localTools.add(t);
      }
    }
  }
  return { servers: canonServers, localTools: [...localTools].sort() };
}

// Parse tool names a local stdio MCP server exposes. Convention in this repo:
// tool names are baked as `TOOL_NAME = "..."` (see mcp/convex-monitor-mcp.mjs).
// Also catch `name: "..."` entries inside an explicit `tools: [ ... ]` array so
// multi-tool servers added later are covered.
function parseLocalTools(absPath) {
  if (!existsSync(absPath)) return [];
  const src = readFileSync(absPath, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/\b(?:TOOL_NAME|toolName)\s*[:=]\s*["'`]([a-zA-Z0-9_]+)["'`]/g)) names.add(m[1]);
  const toolsBlock = src.match(/tools\s*:\s*\[([\s\S]*?)\]/);
  if (toolsBlock) for (const m of toolsBlock[1].matchAll(/name\s*:\s*["'`]([a-zA-Z0-9_]+)["'`]/g)) names.add(m[1]);
  return [...names];
}

function collectApp() {
  const pj = join(PLUGIN, ".codex-plugin", "plugin.json");
  if (!existsSync(pj)) return { version: "", capabilities: [], defaultPrompt: [] };
  const j = readJson(pj);
  const i = j.interface || {};
  return {
    version: j.version || "",
    capabilities: [...(i.capabilities || [])].sort(),
    defaultPrompt: [...(i.defaultPrompt || [])].sort(),
  };
}

function collectSurface() {
  const { servers, localTools } = collectMcp();
  return { skills: collectSkills(), mcpServers: servers, localMcpTools: localTools, app: collectApp() };
}

// Stable fingerprint: canonical JSON (sorted keys) → sha256. `version` is NOT part
// of the hash — bumping the version alone is not a surface change; changing what
// the app DOES is.
function fingerprint(surface) {
  const forHash = { ...surface, app: { capabilities: surface.app.capabilities, defaultPrompt: surface.app.defaultPrompt } };
  return createHash("sha256").update(canonical(forHash)).digest("hex").slice(0, 16);
}
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

// ── diff helpers for a friendly failure message ─────────────────────────────
const setDiff = (was, now) => ({
  added: now.filter((x) => !was.includes(x)),
  removed: was.filter((x) => !now.includes(x)),
});
function describeDrift(base, now) {
  const lines = [];
  const s = setDiff(base.skills || [], now.skills);
  if (s.added.length) lines.push(`  + skill(s): ${s.added.join(", ")}`);
  if (s.removed.length) lines.push(`  - skill(s): ${s.removed.join(", ")}`);
  const t = setDiff(base.localMcpTools || [], now.localMcpTools);
  if (t.added.length) lines.push(`  + MCP tool(s): ${t.added.join(", ")}`);
  if (t.removed.length) lines.push(`  - MCP tool(s): ${t.removed.join(", ")}`);
  const sv = setDiff(Object.keys(base.mcpServers || {}), Object.keys(now.mcpServers));
  if (sv.added.length) lines.push(`  + MCP server(s): ${sv.added.join(", ")}`);
  if (sv.removed.length) lines.push(`  - MCP server(s): ${sv.removed.join(", ")}`);
  for (const name of Object.keys(now.mcpServers)) {
    if (base.mcpServers?.[name] && canonical(base.mcpServers[name]) !== canonical(now.mcpServers[name]))
      lines.push(`  ~ MCP server '${name}' command/args changed`);
  }
  const c = setDiff(base.app?.capabilities || [], now.app.capabilities);
  if (c.added.length || c.removed.length) lines.push(`  ~ app capabilities changed (+${c.added.length}/-${c.removed.length})`);
  const dp = setDiff(base.app?.defaultPrompt || [], now.app.defaultPrompt);
  if (dp.added.length || dp.removed.length) lines.push(`  ~ app defaultPrompt changed (+${dp.added.length}/-${dp.removed.length})`);
  return lines.length ? lines.join("\n") : "  (fingerprint changed; see --print for the full surface)";
}

// ── main ────────────────────────────────────────────────────────────────────
const mode = process.argv.includes("--accept") ? "accept" : process.argv.includes("--print") ? "print" : "check";
const surface = collectSurface();
const fp = fingerprint(surface);

if (mode === "print") {
  console.log(JSON.stringify({ fingerprint: fp, ...surface }, null, 2));
  process.exit(0);
}

if (mode === "accept") {
  // Guard against the failure that caused THIS whole mess: someone ran --accept
  // recording a GitHub surface as "submitted" while OpenAI never published it, so
  // the gate went green while users kept getting the stale build. Require an
  // explicit acknowledgement that a real submission actually landed.
  if (!process.argv.includes("--i-really-submitted-to-openai")) {
    fail([
      "",
      "✗ REFUSING to record a new baseline without proof of an actual OpenAI submission.",
      `  You're about to mark the surface at v${surface.app.version || "?"} as PUBLISHED.`,
      "  Only do this AFTER OpenAI has accepted AND published the new ChatGPT-app build",
      "  (verify: install `convex@openai-curated` fresh and confirm it's the new version).",
      "",
      "  Recording an unsubmitted surface is exactly how this gate lied before: a v0.6.0",
      "  surface was accepted while users kept installing the empty v0.1.2 husk.",
      "",
      "  If the build is genuinely live, re-run with the acknowledgement flag:",
      "    node scripts/codex-review-gate.mjs --accept --i-really-submitted-to-openai",
      "",
    ].join("\n"));
  }
  const prev = existsSync(BASELINE) ? readJson(BASELINE) : {};
  const record = {
    _comment: "PUBLISHED reviewable surface — what OpenAI’s curated registry / ChatGPT app ACTUALLY serves to users. NOT the GitHub HEAD surface. Only regenerate with `--accept --i-really-submitted-to-openai` AFTER OpenAI has accepted+published a new build.",
    publishedVersion: surface.app.version,
    publishedAppId: prev.publishedAppId || "",
    reviewedVersion: surface.app.version,
    fingerprint: fp,
    skills: surface.skills,
    mcpServers: surface.mcpServers,
    localMcpTools: surface.localMcpTools,
    app: surface.app,
  };
  writeFileSync(BASELINE, JSON.stringify(record, null, 2) + "\n");
  console.log(`✓ recorded PUBLISHED surface (fingerprint ${fp}, version ${surface.app.version || "?"}) → ${BASELINE.replace(ROOT + "/", "")}`);
  process.exit(0);
}

// check
if (!existsSync(BASELINE)) {
  fail([
    "✗ No review baseline found (plugins/convex/.codex-review.json).",
    "  Seed it once from the currently-reviewed build:",
    "    node scripts/codex-review-gate.mjs --accept",
    "  then commit it. Afterward this gate fails whenever the reviewable surface",
    "  (MCP tools / skills / app capabilities) changes without a fresh submission.",
  ].join("\n"));
}
const base = readJson(BASELINE);
if (base.fingerprint === fp) {
  console.log(`✓ Codex reviewable surface matches what's PUBLISHED to OpenAI (fingerprint ${fp}, v${base.publishedVersion || base.reviewedVersion || "?"}). Users get this build.`);
  process.exit(0);
}
// Drift exists: the repo is ahead of what OpenAI publishes. This is REPORTED loudly
// but is NOT a hard failure by default — closing the gap needs an out-of-band OpenAI
// submission (app-owner login), so blocking every PR on it would hold CI hostage to a
// slow external action. Use --strict in a release workflow if you want it to block.
const strict = process.argv.includes("--strict");
const pubV = base.publishedVersion || base.reviewedVersion || "?";
const msg = [
  "",
  `${strict ? "✗" : "⚠"} CODEX DISTRIBUTION LAG — users install an OLDER build than this repo.`,
  `    PUBLISHED to OpenAI (what users get): v${pubV}   fingerprint ${base.fingerprint}`,
  `    this repo (HEAD):                     v${surface.app.version || "?"}   fingerprint ${fp}`,
  "  What users are MISSING until a fresh submission ships:",
  describeDrift(base, surface),
  "",
  "  The public Convex Codex app is a reviewed ChatGPT app (see .app.json); the",
  "  curated registry serves the last PUBLISHED build, not GitHub HEAD. To close the gap",
  "  (see OPENAI-SUBMISSION.md):",
  "    1. Submit this build for ChatGPT app review (app in .app.json).",
  "    2. AFTER OpenAI accepts AND publishes it, verify a fresh install shows the new version, then:",
  "         node scripts/codex-review-gate.mjs --accept --i-really-submitted-to-openai",
  "    3. Commit plugins/convex/.codex-review.json with your change.",
  "",
];
// In GitHub Actions, surface it as a warning annotation so it's visible on the PR
// without a red X (and in the strict path, as an error).
if (process.env.GITHUB_ACTIONS) {
  const oneLine = `Codex distribution lag: users install v${pubV}, repo is v${surface.app.version || "?"} (see OPENAI-SUBMISSION.md).`;
  console.log(`::${strict ? "error" : "warning"} title=Codex distribution lag::${oneLine}`);
}
if (strict) fail(msg.join("\n"));
console.warn(msg.join("\n"));
console.log("  (non-blocking: run with --strict to fail on this)");
process.exit(0);
