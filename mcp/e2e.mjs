#!/usr/bin/env node
// End-to-end: drive the REAL MCP server's fix_errors_automatically with the live
// subscription leg, then trigger a Convex mutation and confirm the tool returns
// a typed feature_request event sourced from the reactive subscription.
import { spawn, execSync } from "node:child_process";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const SERVER = path.join(here, "convex-monitor-mcp.mjs");
const PROJ = path.join(here, "legtest");

const srv = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
let buf = ""; const waiters = new Map(); let nextId = 1;
srv.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
const rpc = (method, params) => new Promise((r) => { const id = nextId++; waiters.set(id, r); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const notify = (m, p) => srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  notify("notifications/initialized", {});
  // call the tool against the live deployment, subscribing to counter:get
  const callP = rpc("tools/call", { name: "fix_errors_automatically", arguments: { projectDir: PROJ, queries: ["counter:get"], timeoutMs: 15000 } });
  await sleep(2000); // let the subscription baseline
  console.log("→ triggering a mutation (simulates a user submitting a feature request)…");
  const uniq = "req-"+Date.now();
  execSync(`CONVEX_AGENT_MODE=anonymous npx convex run counter:bump '{\"name\":\"${uniq}\"}'`, { cwd: PROJ, stdio: "inherit" });
  const res = await callP;
  const ev = JSON.parse(res.result.content[0].text);
  console.log("← tool returned:", JSON.stringify(ev));
  const okKind = ev.kind === "feature_request";
  const okData = JSON.stringify(ev).includes(uniq);
  console.log(`${okKind ? "✅" : "❌"} kind === feature_request`);
  console.log(`${okData ? "✅" : "❌"} event carries the new row (e2e-req)`);
  if (!okKind || !okData) fail++;
} catch (e) { console.error("e2e threw:", e); fail++; }
finally { srv.kill(); console.log(fail ? "\n❌ E2E FAIL" : "\n✅ E2E PASS — the MCP tool delivered a reactive event end-to-end"); process.exit(fail ? 1 : 0); }
