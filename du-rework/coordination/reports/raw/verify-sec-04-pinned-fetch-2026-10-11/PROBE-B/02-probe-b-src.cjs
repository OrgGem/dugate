// SEC-04V probe B. Same shape and same separate-process design as probe A,
// except it loads src/pinned-fetch.ts by transpiling it IN MEMORY - the way a
// jest ts-jest run does - instead of loading the built dist artifact.
// Probe A crashed against dist; if this passes, the gap is a stale build and
// the source repair itself is sufficient. If this also throws, the repair is
// insufficient and the whole verdict flips.
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const ROOT = "D:/Git/dugate/du-rework/orchestrator";
const tsPath = path.join(ROOT, "services/orchestrator/node_modules/typescript/lib/typescript.js");
const ts = require(tsPath);

// Register a require hook that transpiles .ts on the fly, so pinned-fetch.ts is
// loaded from source. Nothing on disk is written or changed.
require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  });
  module._compile(out.outputText, filename);
};

const modPath = path.join(ROOT, "packages/egress/src/pinned-fetch.ts");
const { createPinnedFetch } = require(modPath);

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail) });
}

const server = http.createServer(function (req, res) {
  const url = req.url || "/";
  if (url === "/204") { res.writeHead(204, { "Content-Length": "0" }); res.end(); return; }
  if (url === "/205") { res.writeHead(205, { "Content-Length": "0" }); res.end(); return; }
  if (url === "/304") { res.writeHead(304); res.end(); return; }
  if (url === "/head") { res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "5" }); res.end(req.method === "HEAD" ? undefined : "hello"); return; }
  if (url === "/200") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("payload-0123456789"); return; }
  res.writeHead(404); res.end();
});

async function main() {
  const port = await new Promise(function (resolve) { server.listen(0, "127.0.0.1", function () { resolve(server.address().port); }); });
  const base = "http://127.0.0.1:" + port;
  const fetcher = createPinnedFetch({ allowPrivateNetworks: true, timeoutMs: 2000 });
  try {
    for (const status of [204, 205, 304]) {
      let res = null; let err = "";
      try { res = await fetcher(base + "/" + status, { method: "GET" }); } catch (e) { err = e && e.message; }
      check("S" + status + " resolves without throwing", res !== null, err);
      check("S" + status + " status echoed", res !== null && res.status === status, res && res.status);
      check("S" + status + " body is null", res !== null && res.body === null, res && String(res.body));
    }

    let headRes = null; let headErr = "";
    try { headRes = await fetcher(base + "/head", { method: "HEAD" }); } catch (e) { headErr = e && e.message; }
    check("HEAD resolves without throwing", headRes !== null, headErr);
    check("HEAD status is 200", headRes !== null && headRes.status === 200, headRes && headRes.status);
    check("HEAD body is null", headRes !== null && headRes.body === null, headRes && String(headRes.body));

    const okRes = await fetcher(base + "/200", { method: "GET" });
    const okText = await okRes.text();
    check("200 body is not regressed", okText === "payload-0123456789", okText.length + " chars");

    const after = await fetcher(base + "/200", { method: "GET" });
    check("second request after null-body completes", after.status === 200, after.status);
  } finally {
    server.close();
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  }
}

main().then(
  function () {
    const failed = results.filter(function (r) { return !r.ok; });
    for (const r of results) { process.stdout.write((r.ok ? "PASS " : "FAIL ") + r.name + " :: " + r.detail + "\n"); }
    process.stdout.write("PROBE_B_RESULT " + (results.length - failed.length) + "/" + results.length + " checks passed\n");
    process.stdout.write("PROCESS_SURVIVED_REACHED_END\n");
    process.exit(failed.length === 0 ? 0 : 1);
  },
  function (err) {
    process.stdout.write("PROBE_B_UNCAUGHT " + (err && err.stack ? err.stack : String(err)) + "\n");
    process.exit(3);
  }
);