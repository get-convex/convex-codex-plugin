#!/usr/bin/env node
// convex-monitor-mcp.mjs — a stdio MCP server exposing ONE blocking tool,
// `fix_errors_automatically` (server key `convex-plugin`, so it shows in the
// approval prompt as `convex-plugin.fix_errors_automatically` — a name that tells
// the user what they're authorizing: let the agent watch the running app and fix
// errors as they happen). The tool itself is READ-ONLY — it blocks and returns the
// next event; the agent does the editing through its normal tools. It RACES several
// event sources and returns the first one to fire, as a typed event:
//
//   leg 1 (reactive)    Convex subscription → new feature requests / refinements
//   leg 3 (robust)      fs.watch on the local *-errors.log files → convex/next errors
//   leg 4 (typecheck)   debounced fs.watch on convex/*.ts → `convex codegen` + `tsc
//                       --noEmit`, deduped so an unchanged error doesn't re-notify
//   heartbeat           after timeoutMs, returns { kind: "quiet" } so the agent re-arms
//
// Why a blocking tool instead of polling: the agent's idle action becomes
// "call fix_errors_automatically" in a loop — each call is one tool-use that blocks,
// so the agent can't drift into yielding. Leg 3 is load-bearing: the errors that
// bite (convex dev died, push failed, Next won't compile) happen exactly when a
// Convex subscription is blind, so we always keep a local file-watch leg. Leg 4
// closes the last gap: a self-consistent edit (compiles, but breaks Convex's own
// type rules) never lands in *-errors.log because `convex dev` never even ran it
// through a type-checker the same way `tsc --noEmit` does.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 on stdin/stdout.
// stdout is RESERVED for protocol; all diagnostics go to stderr.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

const SERVER_NAME = "convex-plugin";
const SERVER_VERSION = "0.2.1";
const PROTOCOL_VERSION = "2024-11-05";

const log = (...a) => process.stderr.write("[convex-plugin] " + a.join(" ") + "\n");

// ------------------------------------------------------ served monitor spec
// The monitor/notification spec is SERVED from the anteater (single source:
// convex-agents content/machinery/monitors.json → anteater GET /monitors.json)
// — fetch-cache-run with a baked-in offline fallback. On a successful fetch we
// use its per-kind patterns / intervals / descriptions to tune the legs and
// enrich the tool description, so spec fixes ship by redeploying the anteater
// with NO plugin re-release. On ANY failure (offline, timeout, bad JSON, empty
// spec) we run exactly the baked-in behavior below — never crash, never block
// beyond the fetch timeout. The tool NAME and INPUT SCHEMA are identical either
// way (no review-triggering surface change).
const SPEC_URL =
  process.env.CONVEX_MONITOR_SPEC_URL ||
  "https://basic-anteater-667.convex.site/monitors.json";
const SPEC_FETCH_TIMEOUT_MS = 4000;

// Baked-in fallback config == the server's historical behavior, unchanged.
const BAKED_CONFIG = {
  source: "baked-in",
  defaultQueries: ["featureRequests:listPending"],
  patternByKind: {}, // no per-kind line preference → last appended line wins
  pollMsByKind: {}, // → 500ms backup size-poll for every watched log
  kindSummaries: null, // → baked tool description only
};

// --- served-pattern safety (ReDoS bound) -----------------------------------
// Served regexes run against arbitrary log chunks, so a hostile/buggy spec must
// not be able to wedge the server. Three bounds, all per-kind (a bad pattern
// only loses ITS kind's line-preference; baked behavior — last appended line —
// takes over for that kind):
//   1. length cap: pathological patterns are long; ours are short alternations.
//   2. compile-time heuristic: reject a quantified group/class that itself
//      contains a quantifier — the classic catastrophic-backtracking shapes
//      ((a+)+, ([a-z]*)+ , (\w{2,})* …).
//   3. runtime time guard: if any single exec exceeds PATTERN_EXEC_BUDGET_MS,
//      the pattern is disabled for the rest of the process (see the watch leg).
const PATTERN_MAX_LEN = 300;
const PATTERN_EXEC_BUDGET_MS = 50;
const NESTED_QUANTIFIER =
  /(?:\((?:[^()\\]|\\.)*(?:[+*]|\{\d+(?:,\d*)?\})(?:[^()\\]|\\.)*\)|\](?:[+*]|\{\d+(?:,\d*)?\}))\s*(?:[+*]|\{\d+(?:,\d*)?\})/;

function vetServedPattern(pattern) {
  if (pattern.length >= PATTERN_MAX_LEN) return `too long (${pattern.length} >= ${PATTERN_MAX_LEN})`;
  if (NESTED_QUANTIFIER.test(pattern)) return "nested quantifier (catastrophic-backtracking heuristic)";
  return null;
}

// Runtime kill-switch: drop one kind's ACTIVE served pattern (time-guard overrun)
// and fall back to the baked behavior for that kind, for the rest of the process.
function disableServedPattern(kind, why) {
  delete CONFIG.patternByKind[kind];
  log(`served pattern for kind "${kind}" DISABLED (${why}) — baked behavior (last log line) for that kind`);
}

function specToConfig(spec) {
  const cfg = { source: "served", defaultQueries: [], patternByKind: {}, pollMsByKind: {}, kindSummaries: [] };
  for (const m of spec.monitors) {
    if (!m || typeof m.kind !== "string") continue;
    if (typeof m.pattern === "string" && m.pattern) {
      const veto = vetServedPattern(m.pattern);
      if (veto) log(`served pattern for kind "${m.kind}" REJECTED (${veto}) — baked behavior (last log line) for that kind`);
      else try { cfg.patternByKind[m.kind] = new RegExp(m.pattern, "i"); } catch {}
    }
    if (Number.isFinite(m.intervalSec)) {
      // The served intervalSec is the shell-loop cadence on other harnesses; our
      // fs.watch leg is realtime with a backup size-poll — scale interval/10,
      // clamped to [250, 1000]ms so responsiveness never regresses below today's.
      cfg.pollMsByKind[m.kind] = Math.max(250, Math.min(1000, m.intervalSec * 100));
    }
    if (m.kind === "feature_request" && typeof m.query === "string" && m.query.includes(":")) {
      cfg.defaultQueries.push(m.query);
    }
    if (typeof m.description === "string" && m.description) {
      const first = (m.description.match(/^.*?\./) || [m.description])[0];
      cfg.kindSummaries.push(`${m.kind}: ${first.slice(0, 240)}`);
    }
  }
  if (!cfg.defaultQueries.length) cfg.defaultQueries = BAKED_CONFIG.defaultQueries;
  return cfg;
}

// --- integrity check (soft) --------------------------------------------------
// The hub also publishes a hash pin next to the registry (convex-agents
// dist/registry/integrity.json → served at <base>/integrity.json):
//   { hubSha, files: { "monitors.json": <sha256hex>, … } }
// If the pin is PRESENT and carries a hash for monitors.json, the fetched bytes
// must match or the served config is REJECTED (baked fallback + stderr warning)
// — this catches truncation, partial/stale deploys, and registry↔monitors skew.
// If the pin is ABSENT (404) or unparseable, proceed as before (tolerant
// rollout: older anteaters don't serve it yet). NOTE: hash pinning, not signing
// — the pin shares a host with the payload.
const INTEGRITY_FILES = ["integrity.json", "registry-meta.json"];

async function fetchExpectedSpecSha() {
  for (const name of INTEGRITY_FILES) {
    let url;
    try { url = new URL(name, SPEC_URL).href; } catch { continue; }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), SPEC_FETCH_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(t);
      }
      if (!res.ok) continue; // 404/5xx → try the next name / tolerant absence
      const meta = await res.json();
      const sha = meta?.files?.["monitors.json"];
      if (typeof sha === "string" && /^[0-9a-f]{64}$/i.test(sha)) return { sha: sha.toLowerCase(), url };
    } catch { /* unreachable/bad JSON → treat as absent */ }
  }
  return null;
}

let CONFIG = BAKED_CONFIG;
const configReady = (async () => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), SPEC_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(SPEC_URL, { signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Hash the EXACT bytes served (not a re-serialization) so the pin comparison
    // is byte-faithful, then parse the same bytes.
    const raw = Buffer.from(await res.arrayBuffer());
    const spec = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(spec?.monitors) || spec.monitors.length === 0) throw new Error("spec has no monitors[]");
    const pin = await fetchExpectedSpecSha();
    if (pin) {
      const actual = crypto.createHash("sha256").update(raw).digest("hex");
      if (actual !== pin.sha) {
        log(`monitor spec: INTEGRITY MISMATCH — ${pin.url} pins monitors.json at sha256 ${pin.sha.slice(0, 12)}…, fetched bytes hash ${actual.slice(0, 12)}… — REJECTING served config, baked-in fallback`);
        return; // CONFIG stays BAKED_CONFIG
      }
      log(`monitor spec: integrity verified against ${pin.url} (sha256 ${actual.slice(0, 12)}…)`);
    }
    CONFIG = specToConfig(spec);
    log(`monitor spec: SERVED from ${SPEC_URL} (v${spec.version ?? "?"}, ${spec.monitors.length} monitors)`);
  } catch (e) {
    log(`monitor spec: baked-in fallback (${e?.message || e}) — ${SPEC_URL} unavailable; behavior unchanged`);
  }
})();

// ----------------------------------------------------------------- discovery
// Read CONVEX deployment URL from the project's .env.local.
function readConvexUrl(dir) {
  try {
    const txt = fs.readFileSync(path.join(dir, ".env.local"), "utf8");
    for (const key of ["NEXT_PUBLIC_CONVEX_URL", "CONVEX_URL", "VITE_CONVEX_URL"]) {
      const m = txt.match(new RegExp("^" + key + "=(.+)$", "m"));
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return null;
}

// Find the bootstrap's *-errors.log files (convex-errors.log / next-errors.log).
// The bootstrap writes them under a per-run log dir; scan the usual spots.
function findErrorLogs(dir) {
  const found = [];
  const candidates = [dir, path.join(dir, ".logs"), path.join(dir, ".quickstart-logs")];
  // also any .qb.* / quickstart tmp log dirs dropped in the project root
  try {
    for (const e of fs.readdirSync(dir)) {
      if (/(^\.logs|log|qb)/i.test(e)) candidates.push(path.join(dir, e));
    }
  } catch {}
  for (const d of candidates) {
    try {
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) {
        if (/-errors?\.log$/i.test(f) || /^(convex|next).*\.clean\.log$/i.test(f)) {
          found.push(path.join(d, f));
        }
      }
    } catch {}
  }
  return [...new Set(found)];
}

function classifyLog(file) {
  const b = path.basename(file).toLowerCase();
  if (b.includes("next")) return "next_error";
  if (b.includes("convex")) return "convex_error";
  return "dev_error";
}

// ------------------------------------------------------------- leg 4: typecheck
// Debounced fs.watch on convex/*.ts → `convex codegen` + `tsc --noEmit`, only
// notifying when the error output actually changes (a snapshot-diff dedupe, so
// the same unresolved error doesn't re-fire on every debounce cycle).
const TYPECHECK_DEBOUNCE_MS = 800;
const TYPECHECK_TAIL_LINES = 40;

// Last-seen error signature per projectDir, so dedupe survives across repeated
// (loop) calls to fix_errors_automatically — a fresh Promise/race is built each
// call, but the leg's "have we already told the agent about this exact error"
// state must persist across calls, not reset every time.
const lastTypecheckErrorByProject = new Map();

// Injectable/mockable exec seam: by default this leg shells out to the real
// `convex codegen` + `tsc --noEmit`. Tests override CONVEX_MONITOR_TSC_CMD with
// a fake command (e.g. a small fixture script) so they can simulate pass/fail/
// throw without a real Convex project or a real TypeScript install — mirrors
// how CONVEX_MONITOR_SPEC_URL already lets tests swap out the served-spec fetch.
async function runTypecheck(projectDir) {
  const cmd =
    process.env.CONVEX_MONITOR_TSC_CMD ||
    "npx convex codegen && npx tsc --noEmit";
  return exec(cmd, { cwd: projectDir, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
}

// Self-guard: only arm this leg when there's actually a convex/ directory AND
// typescript is resolvable from the project's own node_modules. Returning false
// means the leg must never initialize its watcher — not start and then fail
// silently on every cycle.
function typecheckLegEligible(projectDir) {
  try {
    if (!fs.statSync(path.join(projectDir, "convex")).isDirectory()) return false;
  } catch {
    return false; // no convex/ dir
  }
  try {
    const req = createRequire(path.join(projectDir, "package.json"));
    req.resolve("typescript/package.json");
  } catch {
    return false; // typescript not resolvable (e.g. no node_modules yet)
  }
  return true;
}

function tailLines(text, n) {
  const lines = String(text || "").split("\n").map((s) => s.trimEnd()).filter(Boolean);
  return lines.slice(-n).join("\n");
}

// Arms leg 4 on `projectDir`, calling `finish({ kind: "typecheck_error", ... })`
// the same way every other leg does. Returns a cleanup fn, or null if the
// self-guard declined to start the watcher at all.
function armTypecheckLeg(projectDir, finish, cleanups) {
  if (!typecheckLegEligible(projectDir)) {
    log("convex/ missing or typescript not resolvable — skipping typecheck leg");
    return null;
  }
  const convexDir = path.join(projectDir, "convex");
  let debounceTimer = null;
  let running = false;
  let rerunQueued = false;

  const runOnce = async () => {
    if (running) { rerunQueued = true; return; }
    running = true;
    try {
      await runTypecheck(projectDir);
      // clean run: clear any previously-notified error so a later regression
      // is treated as new again instead of being suppressed by stale state.
      lastTypecheckErrorByProject.delete(projectDir);
    } catch (e) {
      // `exec` rejects both for a genuine non-zero exit (tsc found errors,
      // which is the expected case we want to surface) and for exec-level
      // failures (bad command, ENOENT, timeout). Treat both the same way:
      // pull whatever stderr/stdout text is available and tail it — never
      // let a weird/thrown error crash the server or spam the agent.
      const text = [e?.stderr, e?.stdout, e?.message].filter(Boolean).join("\n");
      const line = tailLines(text, TYPECHECK_TAIL_LINES);
      if (!line) { running = false; if (rerunQueued) { rerunQueued = false; scheduleRun(); } return; }
      const prev = lastTypecheckErrorByProject.get(projectDir);
      if (prev !== line) {
        lastTypecheckErrorByProject.set(projectDir, line);
        finish({ kind: "typecheck_error", file: "convex/*.ts", line });
      }
      // else: identical to the last notified error — stay quiet (dedupe).
    } finally {
      running = false;
      if (rerunQueued) { rerunQueued = false; scheduleRun(); }
    }
  };

  const scheduleRun = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runOnce, TYPECHECK_DEBOUNCE_MS);
  };

  const onChange = (_evt, filename) => {
    if (filename && !String(filename).endsWith(".ts")) return;
    scheduleRun();
  };

  let watcher;
  try {
    watcher = fs.watch(convexDir, { persistent: true }, onChange);
  } catch (e) {
    log(`typecheck leg: watch failed for ${convexDir}: ${e.message}`);
    return null;
  }
  cleanups.push(() => { try { watcher.close(); } catch {} });
  // fs.watch on a directory misses some editor save patterns (atomic
  // rename-over-write) on some platforms; back it with a light mtime poll,
  // same idiom leg 3 uses for its file watches.
  let lastMtimeSig = "";
  const snapshotMtimes = () => {
    let sig = "";
    try {
      for (const f of fs.readdirSync(convexDir)) {
        if (!f.endsWith(".ts")) continue;
        try { sig += f + ":" + fs.statSync(path.join(convexDir, f)).mtimeMs + ";"; } catch {}
      }
    } catch { /* leave sig empty */ }
    return sig;
  };
  lastMtimeSig = snapshotMtimes(); // seed baseline; never schedules a run
  const pollMtimes = () => {
    const sig = snapshotMtimes();
    if (sig !== lastMtimeSig) {
      lastMtimeSig = sig;
      scheduleRun();
    }
  };
  const iv = setInterval(pollMtimes, 500);
  cleanups.push(() => clearInterval(iv));
  cleanups.push(() => { if (debounceTimer) clearTimeout(debounceTimer); });

  log(`typecheck leg: watching ${convexDir}`);
  return true;
}

// --------------------------------------------------------------- the race
async function waitForConvexEvent(args = {}) {
  // The MCP server may be launched with cwd = plugin root (not the project), so
  // prefer an explicit projectDir from the caller, then common workspace env
  // vars, then cwd. The skill instructs the agent to always pass projectDir.
  const projectDir =
    args.projectDir ||
    process.env.CONVEX_MONITOR_PROJECT_DIR ||
    process.env.CODEX_WORKSPACE_ROOT ||
    process.env.PWD ||
    process.cwd();
  const timeoutMs = Math.max(5000, Math.min(args.timeoutMs ?? 90_000, 290_000));
  const queries = args.queries || CONFIG.defaultQueries;

  const cleanups = [];
  const cleanup = () => { while (cleanups.length) { try { cleanups.pop()(); } catch {} } };

  return await new Promise((resolve) => {
    let done = false;
    const finish = (ev) => { if (done) return; done = true; cleanup(); resolve(ev); };

    // --- heartbeat -------------------------------------------------------
    const hb = setTimeout(
      () => finish({ kind: "quiet", note: `no event in ${timeoutMs}ms — call fix_errors_automatically again to keep monitoring` }),
      timeoutMs,
    );
    cleanups.push(() => clearTimeout(hb));

    // --- leg 3: fs.watch the local *-errors.log files --------------------
    const logs = findErrorLogs(projectDir);
    log(`watching ${logs.length} error log(s): ${logs.map((l) => path.basename(l)).join(", ") || "(none found)"}`);
    for (const file of logs) {
      let offset = 0;
      try { offset = fs.statSync(file).size; } catch {}
      const onChange = () => {
        let size = 0;
        try { size = fs.statSync(file).size; } catch { return; }
        if (size < offset) offset = 0; // truncated/rotated
        if (size <= offset) return;
        let chunk = "";
        try {
          const fd = fs.openSync(file, "r");
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          chunk = buf.toString("utf8");
        } catch { return; }
        offset = size;
        const kind = classifyLog(file);
        const lines = chunk.split("\n").map((s) => s.trim()).filter(Boolean);
        // With a served spec, prefer the last line matching that kind's pattern
        // (picks the actual error line out of a chunk over stack-trace tails);
        // without one — or if nothing matches — keep today's behavior: last line.
        // Never suppress an event: the *-errors.log files are pre-filtered.
        // TIME GUARD (ReDoS bound): if any single exec of the served pattern runs
        // longer than PATTERN_EXEC_BUDGET_MS, disable that kind's served pattern
        // for the rest of the process and fall back to baked behavior.
        const re = CONFIG.patternByKind[kind];
        let line = null;
        if (re) {
          for (let i = lines.length - 1; i >= 0; i--) {
            const t0 = Date.now();
            let hit = false;
            try { hit = re.test(lines[i]); } catch { hit = false; }
            if (Date.now() - t0 > PATTERN_EXEC_BUDGET_MS) {
              disableServedPattern(kind, `single exec took >${PATTERN_EXEC_BUDGET_MS}ms`);
              line = null;
              break;
            }
            if (hit) { line = lines[i]; break; }
          }
        }
        if (!line) line = lines.length ? lines[lines.length - 1] : null;
        if (line) finish({ kind, file: path.basename(file), line });
      };
      try {
        const w = fs.watch(file, { persistent: true }, onChange);
        cleanups.push(() => w.close());
        // fs.watch misses some appends on macOS; back it with a light size poll
        // (served spec may tune the cadence per kind; default stays 500ms).
        const iv = setInterval(onChange, CONFIG.pollMsByKind[classifyLog(file)] ?? 500);
        cleanups.push(() => clearInterval(iv));
      } catch (e) { log(`watch failed for ${file}: ${e.message}`); }
    }

    // --- leg 4: debounced typecheck (convex codegen + tsc --noEmit) ------
    armTypecheckLeg(projectDir, finish, cleanups);

    // --- leg 1: Convex subscription (reactive) ---------------------------
    const url = readConvexUrl(projectDir);
    if (url) {
      (async () => {
        // Resolve `convex` from the PROJECT's node_modules (a scaffolded app always
        // has it). The server itself lives elsewhere, so a bare import would miss it.
        let ConvexClient, makeFunctionReference;
        const importFrom = async (spec) => {
          try {
            const req = createRequire(path.join(projectDir, "package.json"));
            return await import(pathToFileURL(req.resolve(spec)).href);
          } catch {
            return await import(spec); // fall back to the server's own resolution
          }
        };
        try {
          const b = await importFrom("convex/browser");
          const s = await importFrom("convex/server");
          // tolerate both ESM named exports and CJS default-wrapped interop
          ConvexClient = b.ConvexClient ?? b.default?.ConvexClient;
          makeFunctionReference = s.makeFunctionReference ?? s.default?.makeFunctionReference;
          if (typeof ConvexClient !== "function" || typeof makeFunctionReference !== "function")
            throw new Error("convex exports not in expected shape");
        } catch (e) {
          log(`convex package not resolvable from ${projectDir} — skipping subscription leg (${e.message})`);
          return;
        }
        try {
          const client = new ConvexClient(url);
          cleanups.push(() => { try { client.close(); } catch {} });
          for (const q of queries) {
            const ref = makeFunctionReference(q); // "module:export"
            // Track each row's _id → content signature, and fire on a NEW row
            // (new feature request) OR a CHANGED row (e.g. a refinement question
            // that just got an answer patched in — same _id, new content).
            const prev = new Map();
            let seeded = false;
            const unsub = client.onUpdate(ref, {}, (rows) => {
              rows = Array.isArray(rows) ? rows : [];
              const changed = [];
              for (const r of rows) {
                const id = r?._id ?? JSON.stringify(r);
                const sig = JSON.stringify(r);
                if (seeded && prev.get(id) !== sig) changed.push(r);
                prev.set(id, sig);
              }
              const kind = q.startsWith("refinement") ? "refinement_answer" : "feature_request";
              if (!seeded) {
                seeded = true;
                // FIRST snapshot: if there's already UNHANDLED work (the user
                // submitted a request / a refinement is open BEFORE this call
                // started), surface it immediately — don't bury it as baseline.
                // listPending/listOpen only return unhandled rows, so a non-empty
                // initial snapshot IS actionable. Empty → wait for the next change.
                if (rows.length) {
                  finish({ kind, query: q, count: rows.length, items: rows.slice(0, 5), existing: true });
                }
                return;
              }
              if (changed.length) {
                finish({ kind, query: q, count: changed.length, items: changed.slice(0, 5) });
              }
            }, (err) => log(`subscription ${q} errored: ${err?.message || err}`));
            cleanups.push(() => { try { unsub(); } catch {} });
          }
          log(`subscribed to ${queries.join(", ")} on ${url}`);
        } catch (e) { log(`subscription leg failed: ${e.message}`); }
      })();
    } else {
      log("no CONVEX_URL in .env.local — skipping subscription leg (file-watch + heartbeat only)");
    }
  });
}

// ----------------------------------------------------------------- MCP wiring
// NAME and inputSchema are FIXED — the served spec may only enrich the
// description text. Changing either would be a review-triggering surface change.
const TOOL_DESCRIPTION_BAKED =
    "Stay on watch and fix runtime errors the moment they happen. BLOCKS until the next " +
    "event in this project and returns it — this tool is read-only (it watches; YOU do the " +
    "fix with your normal edit/run tools). Races: (1) the local *-errors.log files for " +
    "convex/next compile/runtime errors, (2) a Convex subscription for new feature " +
    "requests / refinement answers, and (3) a debounced `convex codegen` + `tsc --noEmit` " +
    "typecheck on convex/*.ts changes. Returns one typed event { kind: feature_request | " +
    "refinement_answer | convex_error | next_error | typecheck_error | quiet }. Use it as " +
    "your standing idle action: after the app's first version is up, call this in a loop " +
    "instead of yielding — each call blocks, so you stay on watch and react the instant " +
    "something happens (an error to fix, or a user request to build). On a " +
    "'convex_error'/'next_error'/'typecheck_error' stop and fix it; on a request/answer " +
    "handle it; on 'quiet' (heartbeat timeout) just call again. ALWAYS pass projectDir = " +
    "the absolute path of the app you scaffolded.";

const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    projectDir: { type: "string", description: "Absolute project root (where .env.local + *-errors.log live). Always pass this." },
    timeoutMs: { type: "number", description: "Heartbeat timeout in ms (default 90000, max 290000)." },
    queries: { type: "array", items: { type: "string" }, description: "Convex query refs to subscribe to (default featureRequests:listPending)." },
  },
};

const TOOL_NAME = "fix_errors_automatically";

// The served spec (when reachable) appends a compact per-kind summary so the
// agent-facing text stays in sync with the single-source monitor descriptions.
function currentTool() {
  let description = TOOL_DESCRIPTION_BAKED;
  if (CONFIG.kindSummaries?.length) {
    description += " Monitored kinds (spec served from Convex): " + CONFIG.kindSummaries.join(" | ");
  }
  return { name: TOOL_NAME, description, inputSchema: TOOL_INPUT_SCHEMA };
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case "notifications/initialized":
      return; // notification, no response
    case "ping":
      return reply(id, {});
    case "tools/list":
      // Wait for the spec fetch to settle (≤ SPEC_FETCH_TIMEOUT_MS; usually
      // instant) so the description reflects the active config deterministically.
      await configReady;
      return reply(id, { tools: [currentTool()] });
    case "tools/call": {
      if (params?.name !== TOOL_NAME) return replyErr(id, -32602, `unknown tool: ${params?.name}`);
      try {
        await configReady;
        const event = await waitForConvexEvent(params.arguments || {});
        return reply(id, { content: [{ type: "text", text: JSON.stringify(event) }] });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: JSON.stringify({ kind: "error", message: e.message }) }], isError: true });
      }
    }
    default:
      if (id !== undefined) replyErr(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return log("bad JSON: " + line.slice(0, 120)); }
  Promise.resolve(handle(msg)).catch((e) => log("handler error: " + e.message));
});
log(`${SERVER_NAME} ${SERVER_VERSION} ready (stdio)`);
