// SEC-04V independent loopback probe, run as a SEPARATE process so that an
// uncaught throw inside the pinned-fetch callback would kill this process.
// Deliberate difference from the suite test: that test enqueues a body of
// "ignored" against statuses 204/205/304. A real 204 carries NO body at all,
// so this probe writes genuinely empty responses with an explicit
// Content-Length: 0 and no payload bytes.
const http = require("node:http");
const path = require("node:path");

const { createPinnedFetch } = require(path.resolve("orchestrator/packages/egress/dist/index.js"));

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

function listen(srv, port) {
  return new Promise(function (resolve) {
    srv.listen(port, "127.0.0.1", function () { resolve(srv.address().port); });
  });
}

async function main() {
  const port = await listen(server, 20000 + (process.pid % 5000));
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

    // Direct demonstration that the original bug premise is real IN THIS
    // PROCESS: constructing a Response with a body against 204 throws.
    let ctorThrew = "";
    try { new Response("body", { status: 204 }); } catch (e) { ctorThrew = e && e.constructor && e.constructor.name; }
    check("native Response with 204 and a body throws (bug premise real)", ctorThrew !== "", ctorThrew || "DID NOT THROW");
  } finally {
    server.close();
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  }
}

main().then(
  function () {
    const failed = results.filter(function (r) { return !r.ok; });
    for (const r of results) { process.stdout.write((r.ok ? "PASS " : "FAIL ") + r.name + " :: " + r.detail + "\n"); }
    process.stdout.write("PROBE_RESULT " + (results.length - failed.length) + "/" + results.length + " checks passed\n");
    process.stdout.write("PROCESS_SURVIVED_REACHED_END\n");
    process.exit(failed.length === 0 ? 0 : 1);
  },
  function (err) {
    process.stdout.write("PROBE_UNCAUGHT " + (err && err.stack ? err.stack : String(err)) + "\n");
    process.exit(3);
  }
);