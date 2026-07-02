#!/usr/bin/env node
// test.mjs — drive the convex-plugin MCP server over stdio and verify:
//   1. MCP handshake (initialize → tools/list)
//   2. leg 3: appending to a *-errors.log makes fix_errors_automatically return a typed error event
//   3. heartbeat: with no event, it returns { kind: "quiet" } after timeoutMs
//   4. served monitor spec: a local /monitors.json is fetched + used (deterministic
//      — the main server is pointed at a local fixture, not the live anteater)
//   5. fallback: with the spec URL pointed at an unreachable port the server logs
//      the baked-in fallback and still delivers events (offline = old behavior)
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const SERVER = new URL("./convex-monitor-mcp.mjs", import.meta.url).pathname;

// scratch project with a .logs dir + an error log
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "chefmon-"));
fs.mkdirSync(path.join(proj, ".logs"));
const errLog = path.join(proj, ".logs", "convex-errors.log");
fs.writeFileSync(errLog, ""); // exists, empty

// local monitor-spec fixture (same shape the anteater serves at /monitors.json)
const SPEC_FIXTURE = JSON.stringify({
  version: 1,
  monitors: [
    { id: "convex-runtime-errors", kind: "convex_error", intervalSec: 30, pattern: "error|exception|TypeError", description: "Convex runtime error stream. Fix it." },
    { id: "next-react-errors", kind: "next_error", intervalSec: 5, pattern: "error|Failed to compile", description: "Next/React error stream. Fix it." },
    { id: "convex-feature-requests", kind: "feature_request", intervalSec: 12, query: "featureRequests:listPending", description: "Chef panel feature requests. Build them." },
  ],
});
const specSrv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(SPEC_FIXTURE);
});
await new Promise((r) => specSrv.listen(0, "127.0.0.1", r));
const SPEC_URL = `http://127.0.0.1:${specSrv.address().port}/monitors.json`;

const srvErr = [];
const srv = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CONVEX_MONITOR_SPEC_URL: SPEC_URL } });
srv.stderr.on("data", (d) => { srvErr.push(d.toString()); process.stderr.write(d); });
let buf = "";
const waiters = new Map();
srv.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((res) => {
  const id = nextId++;
  waiters.set(id, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { (cond ? pass++ : fail++); console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); };

try {
  // 1. handshake
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  ok("initialize returns serverInfo", init.result?.serverInfo?.name === "convex-plugin");
  notify("notifications/initialized", {});
  const list = await rpc("tools/list", {});
  ok("tools/list exposes fix_errors_automatically", list.result?.tools?.[0]?.name === "fix_errors_automatically");

  // 4. served spec — the local fixture was fetched and is the active config
  ok("served spec is active (stderr says SERVED)", srvErr.join("").includes("monitor spec: SERVED from " + SPEC_URL));
  ok("tool description carries served kind summaries", /Monitored kinds \(spec served from Convex\)/.test(list.result?.tools?.[0]?.description || ""));
  ok("input schema unchanged (projectDir/timeoutMs/queries)", JSON.stringify(Object.keys(list.result?.tools?.[0]?.inputSchema?.properties || {})) === JSON.stringify(["projectDir", "timeoutMs", "queries"]));

  // 2. leg 3 — error-log file-watch fires
  const callP = rpc("tools/call", { name: "fix_errors_automatically", arguments: { projectDir: proj, timeoutMs: 8000 } });
  await sleep(800); // let the watcher arm + baseline
  fs.appendFileSync(errLog, "TypeError: Cannot read properties of undefined (reading 'map')\n");
  const res = await callP;
  const ev = JSON.parse(res.result.content[0].text);
  ok("file-watch returns a convex_error event", ev.kind === "convex_error", JSON.stringify(ev));
  ok("event carries the log line", /TypeError/.test(ev.line || ""), ev.line || "");

  // 3. heartbeat — quiet after timeout, no event
  const t0 = Date.now();
  const quietRes = await rpc("tools/call", { name: "fix_errors_automatically", arguments: { projectDir: proj, timeoutMs: 6000 } });
  const quiet = JSON.parse(quietRes.result.content[0].text);
  const elapsed = Date.now() - t0;
  ok("heartbeat returns quiet", quiet.kind === "quiet", `${elapsed}ms`);
  ok("heartbeat waited ~timeoutMs (blocking, not instant)", elapsed >= 5500 && elapsed <= 9000, `${elapsed}ms`);

  // 5. fallback — spec URL unreachable → baked-in config, server still works
  {
    const fbProj = fs.mkdtempSync(path.join(os.tmpdir(), "chefmon-fb-"));
    fs.mkdirSync(path.join(fbProj, ".logs"));
    const fbLog = path.join(fbProj, ".logs", "next-errors.log");
    fs.writeFileSync(fbLog, "");
    const fbErr = [];
    const fb = spawn("node", [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      // port 1 is unassigned/refused everywhere — the fetch fails fast
      env: { ...process.env, CONVEX_MONITOR_SPEC_URL: "http://127.0.0.1:1/monitors.json" },
    });
    fb.stderr.on("data", (d) => fbErr.push(d.toString()));
    let fbBuf = ""; const fbWaiters = new Map(); let fbId = 1;
    fb.stdout.on("data", (d) => {
      fbBuf += d.toString();
      let i;
      while ((i = fbBuf.indexOf("\n")) >= 0) {
        const line = fbBuf.slice(0, i); fbBuf = fbBuf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id && fbWaiters.has(msg.id)) { fbWaiters.get(msg.id)(msg); fbWaiters.delete(msg.id); }
      }
    });
    const fbRpc = (method, params) => new Promise((res) => { const id = fbId++; fbWaiters.set(id, res); fb.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
    await fbRpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    fb.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    const fbList = await fbRpc("tools/list", {});
    ok("fallback engages when fetch fails (stderr says baked-in fallback)", fbErr.join("").includes("monitor spec: baked-in fallback"));
    ok("fallback tool name identical", fbList.result?.tools?.[0]?.name === "fix_errors_automatically");
    ok("fallback description has NO served summaries (old behavior)", !/spec served from Convex/.test(fbList.result?.tools?.[0]?.description || ""));
    const fbCallP = fbRpc("tools/call", { name: "fix_errors_automatically", arguments: { projectDir: fbProj, timeoutMs: 8000 } });
    await sleep(800);
    fs.appendFileSync(fbLog, "Failed to compile: ./app/page.tsx\n");
    const fbRes = await fbCallP;
    const fbEv = JSON.parse(fbRes.result.content[0].text);
    ok("fallback still delivers events (next_error via file-watch)", fbEv.kind === "next_error", JSON.stringify(fbEv));
    fb.kill();
    fs.rmSync(fbProj, { recursive: true, force: true });
  }
} catch (e) {
  console.error("test threw:", e);
  fail++;
} finally {
  srv.kill();
  specSrv.close();
  fs.rmSync(proj, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
