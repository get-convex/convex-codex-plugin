#!/usr/bin/env node
// test.mjs — drive the convex-plugin MCP server over stdio and verify:
//   1. MCP handshake (initialize → tools/list)
//   2. leg 3: appending to a *-errors.log makes fix_errors_automatically return a typed error event
//   3. heartbeat: with no event, it returns { kind: "quiet" } after timeoutMs
//   4. served monitor spec: a local /monitors.json is fetched + used (deterministic
//      — the main server is pointed at a local fixture, not the live anteater).
//      The fixture serves ONLY /monitors.json (404 elsewhere), so this also covers
//      the tolerant path: integrity file absent → served config still accepted
//   5. fallback: with the spec URL pointed at an unreachable port the server logs
//      the baked-in fallback and still delivers events (offline = old behavior)
//   6. ReDoS bound: served patterns that are too long or carry nested quantifiers
//      are REJECTED per kind (spec still SERVED; events fall back to last-line)
//   7. integrity mismatch: /integrity.json pins a wrong sha256 for monitors.json →
//      served config REJECTED, baked-in behavior
//   8. integrity match: correct sha256 pin → served config accepted + verified
import { spawn } from "node:child_process";
import crypto from "node:crypto";
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
// Serve ONLY /monitors.json — /integrity.json etc. 404, like an anteater that
// predates the integrity pin (the tolerant-absence path must keep working).
const specSrv = http.createServer((req, res) => {
  if (req.url.split("?")[0] === "/monitors.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(SPEC_FIXTURE);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
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

  // ---- helpers for the hardening scenarios (6–8) -------------------------
  // tiny fixture HTTP server: routes = { "/monitors.json": <string body>, … }
  const serveRoutes = async (routes) => {
    const s = http.createServer((req, res) => {
      const body = routes[req.url.split("?")[0]];
      if (body === undefined) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    return { close: () => s.close(), url: (p) => `http://127.0.0.1:${s.address().port}${p}` };
  };
  // spawn one MCP server instance wired for rpc + stderr capture
  const startMcp = (env) => {
    const errChunks = [];
    const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    proc.stderr.on("data", (d) => errChunks.push(d.toString()));
    let b = ""; const w = new Map(); let id = 1;
    proc.stdout.on("data", (d) => {
      b += d.toString();
      let i;
      while ((i = b.indexOf("\n")) >= 0) {
        const line = b.slice(0, i); b = b.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id && w.has(msg.id)) { w.get(msg.id)(msg); w.delete(msg.id); }
      }
    });
    const rpc2 = (method, params) => new Promise((res) => { const mid = id++; w.set(mid, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n"); });
    const handshake = async () => {
      await rpc2("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    };
    return { proc, rpc: rpc2, handshake, stderr: () => errChunks.join(""), kill: () => proc.kill() };
  };
  const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

  // 6. ReDoS bound — malicious served patterns are rejected per kind
  {
    const evilSpec = JSON.stringify({
      version: 1,
      monitors: [
        // classic catastrophic backtracking: quantifier inside a quantified group
        { id: "convex-runtime-errors", kind: "convex_error", intervalSec: 30, pattern: "(a+)+$", description: "Convex runtime error stream. Fix it." },
        // over the length cap
        { id: "next-react-errors", kind: "next_error", intervalSec: 5, pattern: "(error|Failed to compile|" + "x".repeat(400) + ")", description: "Next/React error stream. Fix it." },
        { id: "convex-feature-requests", kind: "feature_request", intervalSec: 12, query: "featureRequests:listPending", description: "Chef panel feature requests. Build them." },
      ],
    });
    const evilSrv = await serveRoutes({ "/monitors.json": evilSpec });
    const evilProj = fs.mkdtempSync(path.join(os.tmpdir(), "chefmon-evil-"));
    fs.mkdirSync(path.join(evilProj, ".logs"));
    const evilLog = path.join(evilProj, ".logs", "convex-errors.log");
    fs.writeFileSync(evilLog, "");
    const evil = startMcp({ CONVEX_MONITOR_SPEC_URL: evilSrv.url("/monitors.json") });
    await evil.handshake();
    const evilList = await evil.rpc("tools/list", {});
    ok("malicious nested-quantifier pattern rejected (stderr)", /REJECTED \(nested quantifier/.test(evil.stderr()));
    ok("over-length pattern rejected (stderr)", /REJECTED \(too long/.test(evil.stderr()));
    ok("spec itself still SERVED despite pattern rejections", evil.stderr().includes("monitor spec: SERVED from " + evilSrv.url("/monitors.json")));
    ok("tool name unchanged under malicious spec", evilList.result?.tools?.[0]?.name === "fix_errors_automatically");
    const evilCallP = evil.rpc("tools/call", { name: "fix_errors_automatically", arguments: { projectDir: evilProj, timeoutMs: 8000 } });
    await sleep(800);
    fs.appendFileSync(evilLog, "TypeError: boom at convex/messages.ts\n");
    const evilEv = JSON.parse((await evilCallP).result.content[0].text);
    ok("events still deliver with rejected pattern (baked last-line behavior)", evilEv.kind === "convex_error" && /TypeError/.test(evilEv.line || ""), JSON.stringify(evilEv));
    evil.kill(); evilSrv.close();
    fs.rmSync(evilProj, { recursive: true, force: true });
  }

  // 7. integrity mismatch — served config REJECTED, baked fallback
  {
    const wrongPin = JSON.stringify({ hubSha: "deadbeef", files: { "monitors.json": "0".repeat(64) } });
    const mmSrv = await serveRoutes({ "/monitors.json": SPEC_FIXTURE, "/integrity.json": wrongPin });
    const mm = startMcp({ CONVEX_MONITOR_SPEC_URL: mmSrv.url("/monitors.json") });
    await mm.handshake();
    const mmList = await mm.rpc("tools/list", {});
    ok("hash mismatch is detected (stderr says INTEGRITY MISMATCH)", mm.stderr().includes("INTEGRITY MISMATCH"));
    ok("mismatch rejects served config (no served summaries in description)", !/spec served from Convex/.test(mmList.result?.tools?.[0]?.description || ""));
    ok("mismatch keeps tool name identical", mmList.result?.tools?.[0]?.name === "fix_errors_automatically");
    mm.kill(); mmSrv.close();
  }

  // 8. integrity match — served config accepted + verified
  {
    const goodPin = JSON.stringify({ hubSha: "deadbeef", files: { "monitors.json": sha256(SPEC_FIXTURE) } });
    const okSrv = await serveRoutes({ "/monitors.json": SPEC_FIXTURE, "/integrity.json": goodPin });
    const good = startMcp({ CONVEX_MONITOR_SPEC_URL: okSrv.url("/monitors.json") });
    await good.handshake();
    const goodList = await good.rpc("tools/list", {});
    ok("hash match verifies (stderr says integrity verified)", good.stderr().includes("integrity verified against " + okSrv.url("/integrity.json")));
    ok("hash match accepts served config (SERVED + summaries)", good.stderr().includes("monitor spec: SERVED from") && /spec served from Convex/.test(goodList.result?.tools?.[0]?.description || ""));
    good.kill(); okSrv.close();
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
