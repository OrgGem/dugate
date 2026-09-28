
#### Phần spec CHƯA nằm trong write scope của tôi (báo rõ, không ngụy trang xong)
- "202 URL submission tạo ingestion task" + gate "business task chỉ runnable khi source
  READY" ở nửa ORCHESTRATOR (submission.ts / processIngestionTask / markIngestionReady) —
  ngoài `worker-sdk` + `document-core`. Tôi đã SỬA nửa document-core (mệnh đề "chưa
  READY thì task không chạy được" ở đúng chỗ task thực thi). Nửa orchestrator đã có
  từ trước (Mục 9) nhưng tôi KHÔNG verify lại được ở cycle này vì ngoài scope.
- "HTTPS URL fixture bounded vào S3 trước parse" + SSRF/redirect/rebinding/oversized/
  slow + retry-idempotence: đã có test ở worker-sdk (xem Inventory). Tôi chạy lại 84/84
  xanh nhưng không viết lại — tránh nhân bản coverage của lane khác.
- "failed acquisition không tạo READY": nửa storage/gate ở orchestrator, nửa task ở
  document-core (đã sửa + test).

#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ52 — sửa là TIGHTENING (fail-closed sớm hơn), có thể làm một số task URL cũ đang
  chạy được bằng inline text bắt đầu fail với INGESTION_SOURCE_UNRESOLVED. Đây là
  hành vi ĐÚNG theo spec nhưng là breaking change cho edge case đó; coordinator nên
  biết trước khi nó lên production.
- Δ53 — chưa có live multi-container evidence cho DATA-03 (fetch thật qua egress thật,
  S3 thật, READY gate thật). Cycle này là offline unit + contract. Live thuộc
  DATA-INT-01.

#### Tự phân loại 4 tầng
- SPECIFIED: rõ — chính sách URL, READY gate, không parse bytes dở.
- IMPLEMENTED: 1 file src (gate pin + drop inline khi có pin) + 1 test file mới (5 test).
- VERIFIED (offline): tsc 0; targeted 5/5 x3; FULL 46/46 542/542 Exit 0; regression
  worker-sdk 84/84; 2 mutation probe đúng mục tiêu + restore byte-exact.
- ACCEPTED: không thuộc quyền lane. Nửa orchestrator (202 + READY gate + no-READY-
  on-failure ở storage) và live multi-container (Δ53) chưa verify trong cycle này.
