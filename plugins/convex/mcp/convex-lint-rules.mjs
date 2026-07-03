// convex-lint-rules.mjs — pure lint rules for Convex source files, used by the
// monitor MCP's lint leg (kind `lint_error`).
//
// PROVENANCE / DRIFT NOTE: these are the same hard-deny rules as the Claude
// plugin's PreToolUse hook (convex-backend-skill hooks/convex-lint.mjs, v1.7.6)
// — Codex has no pre-tool-use hook, so instead of blocking the write before it
// lands, the MCP lint leg detects the pattern seconds after the file changes
// and surfaces it as the next event the agent sees (before a `convex dev` push
// cycle is wasted on it). Until the rules are extracted into a served/shared
// module (convex-agents content/), the hook file is the source of truth: port
// rule changes here, keeping regexes identical.
//
// Pure module: `lintConvexSource(relPath, content)` → [{ rule, message }].
// No I/O, no process, no side effects — the leg decides watch/debounce/dedupe.
// Deny discipline (same as the hook): only patterns that are UNAMBIGUOUS in a
// convex/*.ts source file; a false positive is the worst outcome.

// Ground truth for the "convex/server bad symbol" rule: the real named exports
// of the `convex/server` package entrypoint. Generated with:
//   cd /tmp && npm i convex --no-save && node -e \
//     'console.log(JSON.stringify(Object.keys(require("convex/server"))))'
// against convex@1.42.1 (2026-07-02). Static snapshot on purpose: the target
// project may have a different (or no) `convex` resolution from this process.
const CONVEX_SERVER_EXPORTS = new Set([
  "HttpRouter",
  "ROUTABLE_HTTP_METHODS",
  "actionGeneric",
  "anyApi",
  "componentsGeneric",
  "createFunctionHandle",
  "cronJobs",
  "currentSystemUdfInComponent",
  "defineApp",
  "defineComponent",
  "defineSchema",
  "defineTable",
  "filterApi",
  "getFunctionAddress",
  "getFunctionName",
  "httpActionGeneric",
  "httpRouter",
  "internalActionGeneric",
  "internalMutationGeneric",
  "internalQueryGeneric",
  "log",
  "makeFunctionReference",
  "mutationGeneric",
  "queryGeneric",
  "paginationOptsValidator",
  "paginationResultValidator",
  "SearchFilter",
]);

const JS_RESERVED_WORDS = [
  "delete", "new", "class", "function", "return", "import", "default",
  "typeof", "void", "if", "else", "for", "while", "do", "switch", "case",
  "break", "continue", "try", "catch", "finally", "throw", "instanceof",
  "in", "this", "super", "extends", "export", "const", "let", "var",
  "null", "true", "false", "yield", "await", "static", "enum",
];

const NODE_BUILTINS = [
  "crypto", "fs", "path", "http", "https", "child_process", "os", "net",
  "tls", "dns", "stream", "zlib", "util", "buffer", "events", "url",
  "querystring", "assert", "cluster", "dgram", "readline", "repl", "vm",
  "worker_threads", "perf_hooks",
];

function snippet(text) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

// Lint one convex/ TypeScript source. `relPath` is the project-relative path
// (used for schema.ts scoping); `content` is the full file text.
// Returns findings in rule order; empty array = clean.
export function lintConvexSource(relPath, content) {
  const findings = [];
  const add = (rule, message) => findings.push({ rule, message });
  const normalized = String(relPath).replaceAll("\\", "/");
  if (
    !/(^|\/)convex\//.test(normalized) ||
    !normalized.endsWith(".ts") ||
    normalized.endsWith(".d.ts") ||
    normalized.includes("/_generated/")
  ) {
    return findings;
  }
  const projected = String(content);

  // Rule: `.filter(q => … q.field(…))` on a db query — full-table scan.
  const dbFilterRe =
    /\.filter\(\s*\(?\s*(\w+)\s*\)?\s*=>[\s\S]{0,200}?\b\1\.field\(/;
  const dbFilterMatch = dbFilterRe.exec(projected);
  if (dbFilterMatch) {
    add(
      "db_filter",
      `\`${snippet(dbFilterMatch[0])}\` — \`.filter\` scans the whole table on every call. ` +
        `Use \`.withIndex("by_...", q => q.eq(...))\` with an index defined in convex/schema.ts ` +
        `(\`.index("by_<field>", ["<field>"])\`) instead.`,
    );
  }

  // Rule: old positional function syntax `query(async (ctx, …) => …)`.
  const positionalRe =
    /\b(query|mutation|action|internalQuery|internalMutation|internalAction)\(\s*async\s*\(/;
  const positionalMatch = positionalRe.exec(projected);
  if (positionalMatch) {
    add(
      "positional_syntax",
      `\`${snippet(positionalMatch[0])}\` — passing a bare async handler to \`${positionalMatch[1]}\` ` +
        `is the deprecated positional form. Use the object form: ` +
        `${positionalMatch[1]}({ args: {...}, returns: ..., handler: async (ctx, args) => {...} }).`,
    );
  }

  // Rule: function constructors imported from "convex/server" — they live in
  // the generated ./_generated/server.
  const serverPkgImportRe =
    /import\s*\{([^}]*)\}\s*from\s*["']convex\/server["']/g;
  let serverPkgMatch;
  while ((serverPkgMatch = serverPkgImportRe.exec(projected)) !== null) {
    const names = serverPkgMatch[1];
    const fnNameRe =
      /(^|[,\s])(query|mutation|action|internalQuery|internalMutation|internalAction)($|[,\s:])/;
    if (fnNameRe.test(names)) {
      add(
        "server_pkg_import",
        `\`${snippet(serverPkgMatch[0])}\` — \`query\`/\`mutation\`/\`action\` (and internal* variants) ` +
          `are exported from the generated \`./_generated/server\`, not the \`convex/server\` package. ` +
          `Fix: \`import { ${names.trim()} } from "./_generated/server";\`.`,
      );
    }
  }

  // Rule: `internal`/`api` imported from ./_generated/server — they live in
  // ./_generated/api.
  const genServerImportRe =
    /import\s*\{([^}]*)\}\s*from\s*["']\.\/_generated\/server["']/g;
  let genServerMatch;
  while ((genServerMatch = genServerImportRe.exec(projected)) !== null) {
    const names = genServerMatch[1];
    const badNameRe = /(^|[,\s])(internal|api)($|[,\s:])/;
    if (badNameRe.test(names)) {
      add(
        "generated_server_import",
        `\`${snippet(genServerMatch[0])}\` — \`internal\`/\`api\` are exported from \`./_generated/api\`, ` +
          `not \`./_generated/server\`. Fix: \`import { internal, api } from "./_generated/api";\` ` +
          `(keep \`query\`/\`mutation\` etc. on \`./_generated/server\`).`,
      );
    }
  }

  // Rule: `"use node"` in a file that also defines query( / mutation(.
  const useNodeRe = /^\s*["']use node["'];?\s*$/m;
  if (useNodeRe.test(projected)) {
    const queryOrMutationRe = /\b(query|mutation)\s*\(/;
    const qmMatch = queryOrMutationRe.exec(projected);
    if (qmMatch) {
      add(
        "use_node_query_mutation",
        `this file has \`"use node"\` and also defines \`${snippet(qmMatch[0])}…)\` — queries and ` +
          `mutations cannot run in the Node.js runtime, only actions can. Move ${qmMatch[1]} ` +
          `definitions to a file without \`"use node"\`, or convert to an \`action\` that calls ` +
          `a query/mutation via \`ctx.runQuery\`/\`ctx.runMutation\`.`,
      );
    }
  }

  // Rule: a named import from "convex/server" that isn't a real export.
  const serverPkgAnyImportRe =
    /import\s*\{([^}]*)\}\s*from\s*["']convex\/server["']/g;
  let serverAnyMatch;
  while ((serverAnyMatch = serverPkgAnyImportRe.exec(projected)) !== null) {
    const parts = serverAnyMatch[1].split(",").map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
      const exportedName = part.split(/\s+as\s+/)[0].trim();
      if (!exportedName) continue;
      if (!CONVEX_SERVER_EXPORTS.has(exportedName)) {
        const hint =
          exportedName === "HttpResponse"
            ? `\`HttpResponse\` doesn't exist — use \`httpAction\` from \`./_generated/server\` ` +
              `and return a web-standard \`Response\`.`
            : `\`${exportedName}\` is not exported by \`convex/server\`.`;
        add(
          "server_pkg_bad_symbol",
          `\`${snippet(serverAnyMatch[0])}\` — ${hint} \`query\`/\`mutation\`/\`action\`/` +
            `\`httpAction\`/\`internal\`/\`api\` come from \`./_generated/server\` or ` +
            `\`./_generated/api\` instead.`,
        );
      }
    }
  }

  // Rules scoped to schema.ts: reserved index/table names.
  const isSchemaFile = /(^|\/)schema\.ts$/.test(normalized);
  if (isSchemaFile) {
    const indexCallRe = /\.index\(\s*(["'`])((?:(?!\1).)*)\1\s*,\s*(\[[^\]]*\])/g;
    let indexMatch;
    while ((indexMatch = indexCallRe.exec(projected)) !== null) {
      const indexName = indexMatch[2];
      const fieldsLiteral = indexMatch[3];
      if (indexName === "by_id" || indexName === "by_creation_time" || indexName.startsWith("_")) {
        add(
          "reserved_index_name",
          `\`${snippet(indexMatch[0])}\` — \`${indexName}\` is a reserved index name ` +
            `(\`by_id\`/\`by_creation_time\`/\`_\`-prefixed are reserved; Convex auto-appends ` +
            `\`_creationTime\` as the implicit tiebreaker). Rename to describe the field(s), ` +
            `e.g. \`.index("by_<field>", [...])\`.`,
        );
      }
      if (/_creationTime/.test(fieldsLiteral)) {
        add(
          "reserved_index_name",
          `\`${snippet(indexMatch[0])}\` — \`_creationTime\` cannot be listed as an index field; ` +
            `Convex auto-appends it as the implicit tiebreaker on every index. Remove it from ` +
            `the fields array.`,
        );
      }
    }
    const reservedTableRe =
      /(^|[{,]\s*)(["'`]?)(_[A-Za-z0-9_]*)\2\s*:\s*defineTable\s*\(/g;
    let tableMatch;
    while ((tableMatch = reservedTableRe.exec(projected)) !== null) {
      const tableName = tableMatch[3];
      add(
        "reserved_table_name",
        `\`${snippet(`${tableName}: defineTable(`)}\` — \`${tableName}\` is a reserved table name ` +
          `(names starting with \`_\` are reserved). Rename it, e.g. ` +
          `\`${tableName.replace(/^_+/, "")}: defineTable(...)\`.`,
      );
    }
  }

  // Rule: `export const <jsReservedWord> = ...` — esbuild hard failure.
  const reservedIdentifierRe = new RegExp(
    `export\\s+const\\s+(${JS_RESERVED_WORDS.join("|")})\\s*=`,
    "g",
  );
  let reservedIdMatch;
  while ((reservedIdMatch = reservedIdentifierRe.exec(projected)) !== null) {
    const word = reservedIdMatch[1];
    add(
      "reserved_identifier",
      `\`${snippet(reservedIdMatch[0])}\` — \`${word}\` is a JS reserved word and can't be an ` +
        `export name (esbuild: "Expected identifier but found \\"${word}\\""). Rename it, e.g. ` +
        `\`export const remove = ...\` instead of \`export const ${word} = ...\`.`,
    );
  }

  // Rule: Node builtin imported/required without `"use node"` — the default
  // V8-isolate runtime has no Node builtins.
  if (!useNodeRe.test(projected)) {
    const nodeImportRe = new RegExp(
      `(?:import\\s+(?:[\\w*{}\\s,]+\\s+from\\s+)?|require\\(\\s*)` +
        `["'](?:node:)?(${NODE_BUILTINS.join("|")})["']`,
      "g",
    );
    let nodeImportMatch;
    while ((nodeImportMatch = nodeImportRe.exec(projected)) !== null) {
      const mod = nodeImportMatch[1];
      add(
        "node_api_without_use_node",
        `\`${snippet(nodeImportMatch[0])}\` — \`${mod}\` is a Node.js builtin but this file has no ` +
          `\`"use node"\` directive; the default Convex runtime is a V8 isolate, so esbuild fails ` +
          `to resolve it. Move the code to a \`"use node";\` action file, or for \`crypto\` use ` +
          `the Web Crypto API via \`globalThis.crypto\` (no import needed).`,
      );
    }
  }

  // Rule: Express-style `:param` path in an http route — permanently dead code.
  const httpParamRouteRe =
    /\bpath\s*:\s*(["'`])((?:(?!\1).)*\/:[A-Za-z_][A-Za-z0-9_]*(?:(?!\1).)*)\1/g;
  let httpParamMatch;
  while ((httpParamMatch = httpParamRouteRe.exec(projected)) !== null) {
    const routePath = httpParamMatch[2];
    add(
      "http_router_param_route",
      `\`${snippet(httpParamMatch[0])}\` — Convex's \`httpRouter\` has no Express-style \`:param\` ` +
        `segments; \`path: "${routePath}"\` only matches that literal string (unreachable dead ` +
        `code). Use \`pathPrefix: "${routePath.split("/:")[0]}/"\` and parse the trailing segment ` +
        `from \`new URL(request.url).pathname\`.`,
    );
  }

  // Rule: http.route handler not wrapped in httpAction(...).
  const httpRouteBlockRe = /\bhttp\.route\(\s*\{/g;
  let httpRouteBlockMatch;
  while ((httpRouteBlockMatch = httpRouteBlockRe.exec(projected)) !== null) {
    const blockSlice = projected.slice(httpRouteBlockMatch.index, httpRouteBlockMatch.index + 400);
    const handlerMatch =
      /\bhandler\s*:\s*(httpAction\s*\(|async\s*(?:\([^)]*\)|\w+)\s*=>|async\s+function\b|function\b)/.exec(blockSlice);
    if (handlerMatch && !/^httpAction\s*\(/.test(handlerMatch[1])) {
      add(
        "http_route_handler_not_wrapped",
        `\`${snippet(handlerMatch[0])}\` inside \`http.route({...})\` — the \`handler:\` must be ` +
          `wrapped in \`httpAction(...)\` (from \`./_generated/server\`), e.g. ` +
          `\`handler: httpAction(async (ctx, request) => { ... return new Response(...); })\`.`,
      );
    }
  }

  // Rule: `.range(...)` inside a withIndex index-range callback — not a method
  // on IndexRangeBuilder (only eq/gt/gte/lt/lte, chained directly).
  const withIndexBlockRe = /\.withIndex\(\s*(["'`])(?:(?!\1).)*\1\s*,\s*\(?\s*(\w+)\s*\)?\s*=>/g;
  let withIndexMatch;
  while ((withIndexMatch = withIndexBlockRe.exec(projected)) !== null) {
    const param = withIndexMatch[2];
    const bodyStart = withIndexMatch.index + withIndexMatch[0].length;
    const bodySlice = projected.slice(bodyStart, bodyStart + 300);
    const terminatorMatch = /\n\s*\)\s*\.|\n\s*\)\s*;|\n\s*\}\s*\)/.exec(bodySlice);
    const body = terminatorMatch ? bodySlice.slice(0, terminatorMatch.index) : bodySlice;
    const rangeCallRe = new RegExp(`\\b${param}\\.[a-zA-Z]+\\([^)]*\\)\\.range\\(`);
    const rangeMatch = rangeCallRe.exec(body) || /\)\.range\(/.exec(body);
    if (rangeMatch) {
      add(
        "withindex_range_method",
        `\`${snippet(rangeMatch[0])}\` inside \`.withIndex(...)\` — \`.range(...)\` is not a method ` +
          `on Convex's \`IndexRangeBuilder\`; only \`eq\`/\`gt\`/\`gte\`/\`lt\`/\`lte\` exist, ` +
          `chained directly, e.g. \`q.eq("field", v).lte("other", x)\`.`,
      );
    }
  }

  return findings;
}
