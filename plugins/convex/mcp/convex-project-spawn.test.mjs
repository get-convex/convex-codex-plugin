// Spawn-REALITY test for convex_project on Codex: the MCP is launched the way
// codex-cli does — cwd = plugin bundle, STRIPPED env — and we assert convex_project
// is derived from the tool call arg, not the (dead) env. The original unit tests
// injected env directly and thus never caught the structural always-false bug.
// Run: node mcp/convex-project-spawn.test.mjs <path-to-convex-monitor-mcp.mjs> <bundle-dir>
import http from "node:http"; import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const MCP = process.argv[2] || new URL("./convex-monitor-mcp.mjs", import.meta.url).pathname;
const BUNDLE = process.argv[3] || new URL(".", import.meta.url).pathname;
// a real convex project dir to pass as the tool arg
const proj = mkdtempSync(join(tmpdir(),"proj-")); mkdirSync(join(proj,"convex")); writeFileSync(join(proj,"convex.json"),"{}");
// mock PostHog capture server
const events=[]; const srv=http.createServer((req,res)=>{let b="";req.on("data",d=>b+=d).on("end",()=>{try{events.push(JSON.parse(b))}catch{}res.end("{}")})});
await new Promise(r=>srv.listen(0,r)); const host=`http://127.0.0.1:${srv.address().port}`;
// spawn the MCP the way Codex does: cwd = bundle dir, STRIPPED env (no PWD/workspace/project vars)
const env={ CONVEX_PLUGIN_POSTHOG_HOST:host, PATH:process.env.PATH, HOME:process.env.HOME };
const p=spawn("node",[MCP],{cwd:BUNDLE, env, stdio:["pipe","pipe","ignore"]});
const send=(o)=>p.stdin.write(JSON.stringify(o)+"\n");
send({jsonrpc:"2.0",id:1,method:"initialize",params:{}});
setTimeout(()=>send({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"fix_errors_automatically",arguments:{projectDir:proj,timeoutMs:5000}}}),400);
await new Promise(r=>setTimeout(r,3500)); p.kill(); srv.close();
// the capture() detached children POST {host, body}; collect the bodies
const bodies=events.map(e=>e.body||e).filter(Boolean);
const ss=bodies.find(b=>b.event==="plugin_session_start");
const cp=bodies.find(b=>b.event==="plugin_convex_project");
console.log("  events seen:", bodies.map(b=>b.event).join(", ")||"(none)");
console.log("  "+(ss&&ss.properties.harness==="codex"?"✓":"✗")+" plugin_session_start fired, harness=codex, convex_project absent="+(ss? (ss.properties.convex_project===undefined):"?"));
console.log("  "+(cp&&cp.properties.convex_project===true?"✓":"✗")+" plugin_convex_project fired with convex_project=TRUE (from tool arg, despite dead env/cwd)");
process.exit(0);
