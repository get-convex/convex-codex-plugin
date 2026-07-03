#!/usr/bin/env node
// lint-rules.test.mjs — unit tests for convex-lint-rules.mjs (the lint leg's
// pure rule module). Each case: one source string → expected rule id (or clean).
import { lintConvexSource } from "./convex-lint-rules.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { (cond ? pass++ : fail++); console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); };

const rulesOf = (relPath, src) => lintConvexSource(relPath, src).map((f) => f.rule);

// --- hard-deny rules fire -----------------------------------------------
ok("db_filter: .filter(q => q.field(...)) on a db query",
  rulesOf("convex/messages.ts", `export const list = query({ args: {}, handler: async (ctx) => ctx.db.query("messages").filter(q => q.eq(q.field("channel"), "x")).collect() });`).includes("db_filter"));

ok("positional_syntax: query(async (ctx) => ...)",
  rulesOf("convex/messages.ts", `export const list = query(async (ctx) => { return []; });`).includes("positional_syntax"));

ok("server_pkg_import: query imported from convex/server",
  rulesOf("convex/messages.ts", `import { query } from "convex/server";`).includes("server_pkg_import"));

ok("generated_server_import: api from ./_generated/server",
  rulesOf("convex/http.ts", `import { api } from "./_generated/server";`).includes("generated_server_import"));

ok("use_node_query_mutation: \"use node\" + query(",
  rulesOf("convex/stuff.ts", `"use node";\nimport { query } from "./_generated/server";\nexport const q = query({ args: {}, handler: async () => 1 });`).includes("use_node_query_mutation"));

ok("server_pkg_bad_symbol: hallucinated HttpResponse",
  rulesOf("convex/http.ts", `import { HttpResponse } from "convex/server";`).includes("server_pkg_bad_symbol"));

ok("reserved_index_name: by_id in schema.ts",
  rulesOf("convex/schema.ts", `export default defineSchema({ t: defineTable({ a: v.string() }).index("by_id", ["a"]) });`).includes("reserved_index_name"));

ok("reserved_index_name: _creationTime listed as index field",
  rulesOf("convex/schema.ts", `defineTable({ a: v.string() }).index("by_a", ["a", "_creationTime"])`).includes("reserved_index_name"));

ok("reserved_table_name: _migrations table in schema.ts",
  rulesOf("convex/schema.ts", `export default defineSchema({ _migrations: defineTable({ v: v.number() }) });`).includes("reserved_table_name"));

ok("reserved_identifier: export const delete",
  rulesOf("convex/tasks.ts", `export const delete = mutation({ args: {}, handler: async () => {} });`).includes("reserved_identifier"));

ok("node_api_without_use_node: import crypto without directive",
  rulesOf("convex/http.ts", `import crypto from "crypto";\nexport const x = 1;`).includes("node_api_without_use_node"));

ok("node_api_without_use_node: node: prefix too",
  rulesOf("convex/http.ts", `import { readFileSync } from "node:fs";`).includes("node_api_without_use_node"));

ok("http_router_param_route: /tasks/:id",
  rulesOf("convex/http.ts", `http.route({ path: "/tasks/:id", method: "GET", handler: httpAction(async () => new Response()) });`).includes("http_router_param_route"));

ok("http_route_handler_not_wrapped: bare async handler",
  rulesOf("convex/http.ts", `http.route({ path: "/tasks", method: "GET", handler: async (ctx, request) => new Response("ok") });`).includes("http_route_handler_not_wrapped"));

ok("withindex_range_method: .range( inside withIndex callback",
  rulesOf("convex/dashboard.ts", `const rows = await ctx.db.query("alerts").withIndex("by_ack", (q) => q.eq("acknowledged", false).range(0, 10)).collect();`).includes("withindex_range_method"));

// --- clean sources stay clean (false-positive discipline) ----------------
ok("clean: object-form query with withIndex",
  rulesOf("convex/messages.ts", `import { query } from "./_generated/server";\nexport const list = query({ args: {}, returns: v.array(v.any()), handler: async (ctx) => ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", "x")).collect() });`).length === 0);

ok("clean: JS array .filter (no q.field) is allowed",
  rulesOf("convex/util.ts", `export const evens = (xs) => xs.filter(x => x % 2 === 0);`).length === 0);

ok("clean: \"use node\" action file with crypto import",
  rulesOf("convex/nodeStuff.ts", `"use node";\nimport crypto from "crypto";\nexport const x = action({ args: {}, handler: async () => crypto.randomUUID() });`).length === 0);

ok("clean: httpAction-wrapped handler",
  rulesOf("convex/http.ts", `http.route({ path: "/tasks", method: "GET", handler: httpAction(async (ctx, request) => new Response("ok")) });`).length === 0);

ok("clean: legit index name in schema.ts",
  rulesOf("convex/schema.ts", `defineTable({ a: v.string() }).index("by_a", ["a"])`).length === 0);

ok("clean: non-convex path is skipped entirely",
  rulesOf("app/page.ts", `export const delete = 1; import crypto from "crypto";`).length === 0);

ok("clean: _generated is skipped",
  rulesOf("convex/_generated/server.ts", `import crypto from "crypto";`).length === 0);

ok("clean: .d.ts is skipped",
  rulesOf("convex/foo.d.ts", `import crypto from "crypto";`).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
