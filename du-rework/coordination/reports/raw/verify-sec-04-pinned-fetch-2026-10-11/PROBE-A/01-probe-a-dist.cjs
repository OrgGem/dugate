// Probe A - dist path resolver, location-independent.
//
// Provenance: three attempts at resolving the egress artifact landed here, each
// failing in a different way, so all three are recorded.
// 1. Hard-coded absolute path D:\Git\dugate\orchestrator\packages\egress\dist\index.js
//    omits the du-rework segment and cannot resolve from any cwd (MODULE_NOT_FOUND).
// 2. Keyed off __dirname but assumed the probe lived in D:\Git\dugate, so it failed
//    as soon as it was installed into the raw evidence directory.
// 3. This version walks upward from its own location looking for a directory that
//    holds orchestrator/packages/egress/dist/index.js, and also accepts an explicit
//    root as argv[2]. It works from wherever the repo tree places it.
//
// Run as a SEPARATE process so an uncaught throw takes the process down. Wire shape:
// a genuine empty 204/205/304 with Content-Length 0 and no payload bytes.
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

function locateRepoRoot() {
  if (typeof process.argv[2] === "string" && process.argv[2].length > 0) {
    const explicit = process.argv[2];
    if (fs.existsSync(path.join(explicit, "orchestrator", "packages", "egress", "dist", "index.js"))) {
      return explicit;
    }
  }
  let dir = __dirname;
  for (let i = 0; i < 14; i++) {
    if (fs.existsSync(path.join(dir, "orchestrator", "packages", "egress", "dist", "index.js"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  return null;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail) });
}

function finish() {
  const failed = results.filter(function (r) { return !r.ok; });
  for (const r of results) { process.stdout.write((r.ok ? "PASS " : "FAIL ") + r.name + " :: " + r.detail + "\n"); }
  process.stdout.write("PROBE_RESULT " + (results.length - failed.length) + "/" + results.length + " checks passed\n");
  process.stdout.write("PROCESS_SURVIVED_REACHED_END\n");
  process.exit(failed.length === 0 ? 0 : 1);
}

const root = locateRepoRoot();
if (root === null) {
  check("locate egress dist", false, "no ancestor holds orchestrator/packages/egress/dist/index.js");
  finish();
} else {
  check("locate egress dist", true, path.join(root, "orchestrator/packages/egress/dist").replace(/\\/g, "/"));

  let mod = null;
  try {
    mod = require(path.join(root, "orchestrator", "packages", "egress", "dist", "index.js"));
    check("dist module loads", true, "");
  } catch (e) {
    check("dist module loads", false, (e && e.message || String(e)).slice(0, 120));
    finish();
  }

  if (mod !== null) {
    run(mod.createPinnedFetch({ allowPrivateNetworks: true, timeoutMs: 2000 }));
  }
}

function run(fetcher) {
  const server = http.createServer(function (req, res) {
    if (req.url === "/204") { res.writeHead(204, { "Content-Length": "0" }); res.end(); return; }
    if (req.url === "/205") { res.writeHead(205, { "Content-Length": "0" }); res.end(); return; }
    if (req.url === "/304") { res.writeHead(304); res.end(); return; }
    if (req.url === "/head") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "5" });
      res.end(req.method === "HEAD" ? undefined : "hello");
      return;
    }
    if (req.url === "/200") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("payload-0123456789"); return; }
    res.writeHead(404); res.end();
  });

  server.listen(0, "127.0.0.1", async function () {
    const base = "http://127.0.0.1:" + server.address().port;
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
      if (typeof server.closeAllConnections === "function") { server.closeAllConnections(); }
    }
  });
}

function finish() {
  const failed = results.filter(function (r) { return !r.ok; });
  for (const r of results) { process.stdout.write((r.ok ? "PASS " : "FAIL ") + r.name + " :: " + r.detail + "\n"); }
  process.stdout.write("PROBE_RESULT " + (results.length - failed.length) + "/" + results.length + " checks passed\n");
  process.stdout.write("PROCESS_SURVIVED_REACHED_END\n");
  process.exit(failed.length === 0 ? 0 : 1);
}

process.on("uncaughtException", function (e) {
  process.stdout.write("PROBE_UNCAUGHT " + (e && e.stack ? e.stack : String(e)) + "\n");
  process.exit(3);
});