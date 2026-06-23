#!/usr/bin/env node
// test.mjs — drive the convex-plugin MCP server over stdio and verify:
//   1. MCP handshake (initialize → tools/list)
//   2. leg 3: appending to a *-errors.log makes fix_errors_automatically return a typed error event
//   3. heartbeat: with no event, it returns { kind: "quiet" } after timeoutMs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER = new URL("./convex-monitor-mcp.mjs", import.meta.url).pathname;

// scratch project with a .logs dir + an error log
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "chefmon-"));
fs.mkdirSync(path.join(proj, ".logs"));
const errLog = path.join(proj, ".logs", "convex-errors.log");
fs.writeFileSync(errLog, ""); // exists, empty

const srv = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
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
} catch (e) {
  console.error("test threw:", e);
  fail++;
} finally {
  srv.kill();
  fs.rmSync(proj, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
