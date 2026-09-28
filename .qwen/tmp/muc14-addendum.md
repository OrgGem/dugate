#### Bổ sung Verify (cuối cycle 14 — đo thêm sau khi fix đã chốt)
- Full offline run 11:12Z (sau fix): Test Suites: 1 skipped, 74 passed, 74 of 75;
  Tests: 28 skipped, 1789 passed, 1817 total — 0 failed.
- Full offline run 11:19Z (cùng trạng thái file, không sửa gì thêm): 1 failed =
  admin-error-boundary-offline.test.ts 'IdP callback leg escaping upstream',
  `connect ETIMEDOUT 127.0.0.1:63378`; Tests: 1 failed, 1788 passed, Exit Code: 1.
- Cô lập suite đó: attempt1 ĐỎ (ETIMEDOUT port KHÁC: 63401), attempt2 XANH
  21 passed / Exit Code: 0, attempt3 XANH 21 passed / Exit Code: 0.
- Bằng chứng môi trường: Get-NetTCPConnection đếm 94.336 TimeWait và 87.071 socket
  LocalPort >= 49152 trên máy (toàn bộ fleet đang chạy). ETIMEDOUT (không phải
  ECONNREFUSED) + port thay đổi mỗi lần + mtime file 2026-09-25T18:27 (không ai sửa
  từ 2 ngày, ke ca cac source no do) => KHAO KHAN ephemeral-port, không phải regression.
- Δ35 (mở, đề nghị Verify/Coordinator ghi nhận là hazard môi trường, KHÔNG giao
  cho lane nào sửa code): suite loopback HTTP của Admin dễ đỏ dây chuyền khi máy
  cạn cổng tạm thời. Lần sau ai thấy đỏ ở suite này: kiểm port + chạy lại cô lập
  TRƯỚC khi nghi product; nên chạy trong quiet window (kiểu Δ82 QUIET-PORT của
  Admin lane) hoặc thêm retry/backoff cho connect.
- Chuốt lại Δ31 cho đúng chủ: connector-revision-http-offline.functional.test.ts
  chính là f3 của lane Platform (SHA 012183af/398 khớp record cycle 8), không phải
  file Vault lane. Mục 13 ghi 'pre-existing, untracked' là đúng trạng thái nhưng
  sai tư cách sở hữu; bản sửa nằm ở cycle 8 (seed binding), còn raw POST ở test
  restart/reconcile thì chưa từng được cập nhật sau khi route mang binding bắt buộc.
- Không có mutation probe cho cycle này: đối tượng sửa là fixture gọi HTTP, lưới
  bằng chứng là cặp thực nghiệm A/B + 8/8 x3 + full run.
