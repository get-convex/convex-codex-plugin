// node --test suite for mcp/analytics.mjs + the plugin_session_start emit in
// convex-monitor-mcp.mjs.
//
// Same discipline as test.mjs: no mocking of server internals — the server is
// spawned for real over stdio and the telemetry POST is observed for real
// (CONVEX_PLUGIN_POSTHOG_HOST points at a local HTTP sink), so these tests
// cover the full path: initialize → capture() → detached emitter child →
// POST. The opt-out tests assert the *absence* of a POST inside a grace
// window — kept short because the emitter child fires immediately when it
// fires at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isConvexProject } from "./analytics.mjs";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "convex-monitor-mcp.mjs");

// --- local PostHog sink ------------------------------------------------
const inbox = [];
let notify = null;
const sink = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    inbox.push({ url: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    if (notify) notify();
  });
});
await new Promise((r) => sink.listen(0, "127.0.0.1", r));
const SINK_URL = `http://127.0.0.1:${sink.address().port}`;
test.after(() => sink.close());

function takeCapture(timeoutMs = 5000) {
  if (inbox.length) return Promise.resolve(inbox.shift());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      notify = null;
      reject(new Error("no telemetry POST arrived within the timeout"));
    }, timeoutMs);
    notify = () => {
      clearTimeout(t);
      notify = null;
      resolve(inbox.shift());
    };
  });
}

function waitQuiet(ms = 1200) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      notify = null;
      resolve();
    }, ms);
    notify = () => {
      clearTimeout(t);
      notify = null;
      reject(new Error(`unexpected telemetry POST: ${JSON.stringify(inbox)}`));
    };
  });
}

// Spawn the MCP server with telemetry ENABLED and pointed at the sink.
// The spec URL targets a refused port so no live anteater fetch happens, and
// DO_NOT_TRACK/CONVEX_PLUGIN_TELEMETRY are cleared so a developer's global
// opt-out can't flip the emit-path tests.
function startServer(envOverrides = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "ignore"],
    env: {
      ...process.env,
      CONVEX_PLUGIN_POSTHOG_KEY: "phc_test",
      CONVEX_PLUGIN_POSTHOG_HOST: SINK_URL,
      CONVEX_PLUGIN_TELEMETRY: "",
      DO_NOT_TRACK: "",
      CONVEX_MONITOR_SPEC_URL: "http://127.0.0.1:1/monitors.json",
      ...envOverrides,
    },
  });
  let buf = "";
  const waiters = new Map();
  let nextId = 1;
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { proc, rpc, kill: () => proc.kill() };
}

const INIT_PARAMS = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "analytics-test", version: "0" },
};

function tmpProject() {
  return mkdtempSync(join(tmpdir(), "convex-codex-telemetry-"));
}

// --- isConvexProject unit coverage ---------------------------------------

test("isConvexProject: convex/ directory → true", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, "convex"));
  assert.equal(isConvexProject(dir), true);
});

test("isConvexProject: convex.json file → true", () => {
  const dir = tmpProject();
  writeFileSync(join(dir, "convex.json"), "{}");
  assert.equal(isConvexProject(dir), true);
});

test("isConvexProject: convex dep in package.json → true; plain project → false", () => {
  const withDep = tmpProject();
  writeFileSync(
    join(withDep, "package.json"),
    JSON.stringify({ dependencies: { convex: "^1.0.0" } }),
  );
  assert.equal(isConvexProject(withDep), true);
  const plain = tmpProject();
  writeFileSync(
    join(plain, "package.json"),
    JSON.stringify({ dependencies: { react: "^18.0.0" } }),
  );
  assert.equal(isConvexProject(plain), false);
});

test("isConvexProject: nonexistent / bogus input → false, never throws", () => {
  assert.equal(isConvexProject(join(tmpdir(), "definitely-not-a-real-dir-xyz")), false);
  assert.equal(isConvexProject(""), false);
  assert.equal(isConvexProject(null), false);
});

// --- initialize → plugin_session_start over the real server ---------------

test("initialize emits plugin_session_start with harness=codex and convex_project=true", async () => {
  const dir = tmpProject();
  mkdirSync(join(dir, "convex"));
  const srv = startServer({ CONVEX_MONITOR_PROJECT_DIR: dir });
  try {
    const init = await srv.rpc("initialize", INIT_PARAMS);
    assert.equal(init.result.serverInfo.name, "convex-plugin");
    const { url, body } = await takeCapture();
    assert.equal(url, "/capture/");
    assert.equal(body.api_key, "phc_test");
    assert.equal(body.event, "plugin_session_start");
    assert.ok(body.distinct_id, "distinct_id must be set");
    assert.equal(body.properties.harness, "codex");
    assert.equal(body.properties.convex_project, true);
    assert.equal(body.properties.os, process.platform);
    assert.equal(body.properties.node_version, process.version);
    assert.ok(body.properties.plugin_version, "plugin_version must be set");
    // The path itself must never ride along.
    assert.ok(!JSON.stringify(body).includes(dir), "project dir must not be sent");
  } finally {
    srv.kill();
  }
});

test("non-Convex project dir → convex_project=false; second initialize does not double-emit", async () => {
  const srv = startServer({ CONVEX_MONITOR_PROJECT_DIR: tmpProject() });
  try {
    await srv.rpc("initialize", INIT_PARAMS);
    const { body } = await takeCapture();
    assert.equal(body.properties.convex_project, false);
    // A client re-initializing the same server process must not double-count.
    await srv.rpc("initialize", INIT_PARAMS);
    await waitQuiet();
  } finally {
    srv.kill();
  }
});

test("CONVEX_PLUGIN_TELEMETRY=0 → initialize works, no POST", async () => {
  const srv = startServer({ CONVEX_PLUGIN_TELEMETRY: "0" });
  try {
    const init = await srv.rpc("initialize", INIT_PARAMS);
    assert.equal(init.result.serverInfo.name, "convex-plugin");
    await waitQuiet();
  } finally {
    srv.kill();
  }
});

test("DO_NOT_TRACK=1 → initialize works, no POST", async () => {
  const srv = startServer({ DO_NOT_TRACK: "1" });
  try {
    const init = await srv.rpc("initialize", INIT_PARAMS);
    assert.equal(init.result.serverInfo.name, "convex-plugin");
    await waitQuiet();
  } finally {
    srv.kill();
  }
});
