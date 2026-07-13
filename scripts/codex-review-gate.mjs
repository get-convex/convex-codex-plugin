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
  const record = {
    _comment: "Records the Codex reviewable surface last SUBMITTED for ChatGPT app review. Regenerate with `node scripts/codex-review-gate.mjs --accept` after you submit a new build.",
    reviewedVersion: surface.app.version,
    fingerprint: fp,
    skills: surface.skills,
    mcpServers: surface.mcpServers,
    localMcpTools: surface.localMcpTools,
    app: surface.app,
  };
  writeFileSync(BASELINE, JSON.stringify(record, null, 2) + "\n");
  console.log(`✓ recorded reviewed surface (fingerprint ${fp}, version ${surface.app.version || "?"}) → ${BASELINE.replace(ROOT + "/", "")}`);
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
  console.log(`✓ Codex reviewable surface unchanged since review (fingerprint ${fp}, reviewed at v${base.reviewedVersion || "?"}). No re-submission needed.`);
  process.exit(0);
}
fail([
  "",
  "✗ CODEX RE-REVIEW REQUIRED — the reviewable surface changed since the last submission.",
  `    reviewed fingerprint: ${base.fingerprint} (v${base.reviewedVersion || "?"})`,
  `    current  fingerprint: ${fp} (v${surface.app.version || "?"})`,
  "  What changed:",
  describeDrift(base, surface),
  "",
  "  The public Convex Codex app is a reviewed ChatGPT app. Before this ships:",
  "    1. Submit a new build for ChatGPT app review (see .app.json).",
  "    2. After it's accepted, record the new surface:",
  "         node scripts/codex-review-gate.mjs --accept",
  "    3. Commit plugins/convex/.codex-review.json with your change.",
  "",
].join("\n"));
