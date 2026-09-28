const fs = require("fs");
let done = 0;
const p1 = "D:/Git/dugate/du-rework/coordination/reports/qwen3.md";
const sec = fs.readFileSync("D:/Git/dugate/.qwen/tmp/w49q313.txt", "utf8");
let raw = fs.readFileSync(p1, "utf8");
if (raw.indexOf("## W49-Q3-13") === -1) { if (!raw.endsWith("\n")) raw += "\n"; fs.writeFileSync(p1, raw + sec); done++; }
const p2 = "D:/Git/dugate/du-rework/coordination/dispatch-receipts.md";
const rc = "\n\n## Cycle 102 — SSRF & private-IP deny matrix on @du/egress (Qwen lane, 2026-09-25 09:4x +07)\n\n" +
"15-case offline matrix (new tests/egress-ssrf-deny-matrix.boundary.test.ts): every packet-named\n" +
"range denied on FIRST adjudicated answer with DestinationDeniedError and a SHARED loopback\n" +
"listener as zero-socket oracle (requests===0 per case, resolveCalls===1); +mixed-answer,\n" +
"compressed-mapped, and narrow-opt-in (metadata denied even allowPrivateNetworks=true) cases.\n" +
"src/egress unchanged (test-only cycle); aggregator +1 entry. verify-r1c 116/116 exit 0 across\n" +
"7 suites; egress lint+build 0. No DB window; no commit/push (git untouched, per packet).\n" +
"Report: ## W49-Q3-13.\n";
let raw2 = fs.readFileSync(p2, "utf8");
if (raw2.indexOf("Cycle 102 —") === -1) { if (!raw2.endsWith("\n")) raw2 += "\n"; fs.writeFileSync(p2, raw2 + rc); done++; }
console.log("written files:", done);