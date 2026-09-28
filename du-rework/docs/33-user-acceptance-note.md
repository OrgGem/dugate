# Nghiem thu cho USER (khong hoi orchestrator)

## P1-03 (validator)

- Lenh: `python du-rework/tools/openapi/validate_openapi.py` (sau `python
  du-rework/tools/openapi/gen_openapi.py`). Exit code: 0. PASS: 23/23
  (submit, poll page, submit-ack, view/detail, result, artifact
  upload/finalize/access, grant/request/response, usage event/batch,
  claim/heartbeat/step/children/wait/complete/fail).
- 3 thu no KHONG chung minh: (1) examples la fixtures doc lap, khong trich
  tu spec; (2) chua co real HTTP response shape nao duoc check; (3) chua co
  in-repo CI wiring ngoai lenh tay.

## P0-06 (two-doc assumption set)

- IMPLEMENTED co file+constant: text 100k, artifacts 20/10, pages 500, QA
  20, maxWords 10k, schema depth 5, zip 50MB, page limit 20 default/100 max,
  grant TTL 15m, poll cap 30s, sweep/drain/probe/quota timeouts (docs/22
  table + workload-assumptions.md).
- TARGET/UNENFORCED: upload 10MB, pages 100, rows 50k, artifact 20MB,
  retention 7/30 ngay, action mix %, tenant concurrency, RPS, p50/p95/p99.
- Dong plan-ma-voi: khong thay mau thuan giua P0-06 acceptance
  (benchmark ghi la assumption) va hai file hien tai; de xuat USER tick
  khi chap nhan cac TARGET tren la du cho P8-05.
