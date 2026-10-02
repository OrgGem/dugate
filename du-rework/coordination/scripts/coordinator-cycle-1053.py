#!/usr/bin/env python3
# Cycle ~10:53 — settle 4 receipts, nudge par04 (3rd unchanged), dispatch wave 9 (read-only)
import json, subprocess, collections
p = r'D:\Git\dugate\du-rework\coordination\agent-watch-state.json'
d = json.load(open(p, encoding='utf-8'), object_pairs_hook=collections.OrderedDict)
disp = d['dispatches']
NOW = "2026-10-01T10:53:00+07:00"

def set_status(key, status, receipt=None, **extra):
    e = disp.get(key)
    if not e:
        print("MISSING", key); return
    e['status'] = status
    e['lastObservedAt'] = NOW
    if receipt is not None:
        e['receipt'] = receipt
    for k, v in extra.items():
        e[k] = v

# ---------- C2 SETTLE (verified receipts) ----------
set_status("ctx_task_usage_cost_reconciliation", "settled",
  "reports/qwen-admin.md:6272 Mục 68 task_par00_reconcile (A=api_keys.totalUsed stored vs B=SUM(operations.totalCostUsd) query-time; NO reconciliation job in legacy - grep reconcil/recompute/backfill=1 unrelated seed.ts:142; 8 divergence D-1..D-8 incl D-1 crash-between-UPDATEs engine.ts:412/417, D-2 null apiKeyId orphaned cost, D-5 BullMQ retry SET-vs-+= erases prior cost; units legacy doublePrecision USD vs rework int microusd - round-trip lossy; no-fabrication+dedup-at-source chosen; hard checks honored)")
set_status("ctx_task_comp05_projection_fixture_spec", "settled",
  "reports/codex-comp05-executable-fixture-spec-2026-10-01.md (EXECUTABLE SPEC not live-verified - ports 2023/3000 down; progress_percent=0 = SYNTHETIC GAP prediction, 'do not assert 0 is expected parity for RUNNING'; NO maxInlineBytes invented - 'there is no maxInlineBytes decision point'; mounted handler is POST /api/v1/docs/ingest not /api/v1/ingest; no x-api-key-id/x-user-id sent)")
set_status("ctx_task_comp06_operations_fence_char", "settled",
  "reports/tester.md:12131 COMP-06 fence matrix (resolveApiKey at list:1791/detail:1832/result:1928/download:2012/cancel:2091/resume:2101; legacy list-no-resolve + header-only fence + resume cross-tenant write = MUST-NOT-REPLICATE; NO admin fallback proposed; legacy /operations/{id}/download ABSENT in rework -> /artifacts/{id}/download tenant-scoped)")
set_status("ctx_task_webhook_delivery_wire_char", "settled",
  "reports/codex-webhook-wire-contract-2026-10-01.md (legacy per-branch JSON shapes; normal-pipeline retry x3 10s vs workflow no-retry/no-timeout; rework durable 5-attempt + backoff; ENABLED-but-FAILING encryption -> WEBHOOK_ENCRYPTION_FAILED, NO request sent, NO plaintext fallback; plaintext-when-policy-absent = server policy NOT failure fallback; receiver incompatible even plaintext - shape differs)")

# ---------- C2 NUDGE: par04 (63bf0dbc) 3rd unchanged read, no receipt ----------
set_status("ctx_task_par04_schema_gap", None,
  lastNudgeAt=NOW, consecutiveUnfinishedChecks=3)

d['lastCheckedAt'] = NOW
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(p, 'a', encoding='utf-8').write('\n')
print("settle+nudge written; total", len(disp))

# ---------- C2b send the single nudge ----------
ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
def send(h, text):
    r = subprocess.run([ORCA, "terminal", "send", "--terminal", h, "--text", text, "--enter", "--json"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    try: ok = json.loads(r.stdout).get("ok")
    except Exception: ok = "raw:" + (r.stdout or r.stderr)[:120]
    print("nudge", h[:18], "->", ok)

send("term_63bf0dbc-d90e-406d-8089-37dfc45ed4bb",
     "You have been read 3 times with no change and no receipt. Stop the 'expected-failure test' framing for F1-F5: do not use a failing test to excuse a defect that must be fixed. Deliver the actual read-only characterization receipt NOW - per-schema field-level table (F1-F5) with file:line for legacy and rework, each field marked present/absent/divergent, and the 5-vs-3 section conflict raised as a question for COMP-00, not a verdict you pick. Write it to reports/qwen-platform.md as a new numbered section and state clearly it ticks no gate.")