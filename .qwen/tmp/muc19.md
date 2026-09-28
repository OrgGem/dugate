
---

## 19 — CYCLE 19: W-ENC-04-SEAM worker-side crypto seam (task_9dd3248fe32b, ctx_9f1e5d8a98e9)

#### Vì sao cycle 18 BLOCKED và cycle này làm được
- Mục 18 chặn vì facade nằm ở orchestrator + worker chưa có đường nhận DEK + packet
  ghi sai `packages/document-core`. Operator mở scope cho (1) port facade + (2) seam
  tiêm qua deps; (3) đường dẫn document-core vẫn không dùng tới (xem Δ46).

#### Deliverable
1. `src/crypto-storage.ts` NEW, 910 dòng, sha cc7db569 — PORT TRUNG THỰC của
   `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts`.
   Port bằng SCRIPT COPY (không gõ tay) + patch import, nên phần thân khớp 100%;
   chỉ khác: bỏ import `vault-transit-provider` và khai báo 3 type cục bộ
   (`WrappedDek`, `WrapDekInput`, `CryptoKeyProvider`) vì worker-sdk không được
   phụ thuộc orchestrator. Alias `CryptoKeyProvider` -> `CryptoStorageKeyProvider`
   để không trùng với interface export (lỗi compile lần 1, đã sửa).
   Không "dọn dẹp" bất kỳ chi tiết wire nào — xem Δ43.
2. `src/crypto-seam.ts` NEW, 158 dòng, sha 54c238aa — seam theo task: bind facade
   vào tenant của CLAIM, trả về handle mà handler chỉ chọn được artifact/version.
3. `src/task-context.ts` (7441eb3c): `TaskContextDeps.crypto?` optional +
   `cryptoFor(binding)` + `sealArtifactBytes()`; single-PUT upload path seal TRƯỚC
   khi bytes rời process, và `finalizeArtifact` nhận size/digest của CIPHERTEXT.
4. `src/index.ts` (b1057462): export facade + seam qua entrypoint.
5. `tests/crypto-seam.test.ts` NEW, 248 dòng, sha d0ea67f0, 14 test.

#### Quyết định thiết kế đáng ghi
- **Không** thêm `cryptoFor` vào interface `TaskContext` công khai: làm vậy sẽ phá
  `MockTaskContext` ở document-core (ngoài scope — Δ42/Δ46). Nên nó là method trên
  `DefaultTaskContext`; handler dùng interface vẫn không ảnh hưởng.
- **Tenant do CLAIM quyết định, không phải handler.** Nếu handler tự truyền tenantId,
  mỗi call site là một chỗ sai sót, và AAD sẽ trung thực gắn SAI tenant — hợp lệ về
  mật mã nhưng chủ thật không đọc được. Bind một lần ở claim để xoá hẳn lớp lỗi đó.
- **Single-PUT > 5 MiB thì TỪ CHỐI**, không ghi plaintext, không "tạm ghi thẳng":
  chunked manifest chưa có chỗ để đi (finalize body chưa có field manifest — Δ44).
  Refuse loudly hơn là âm thầm rò.
- `expectedSha256` của caller vẫn là HỢP ĐỒNG PLAINTEXT: verify trước khi seal,
  không forward xuống upload helper (nơi nó đã là digest của ciphertext).

#### Verify (offline, literal exit code)
- `pnpm --filter @du/worker-sdk exec tsc --noEmit` — Exit Code: 0 (sau mỗi hunk; 2
  lỗi compile trung thực được sửa: trùng tên type, AAD -> string | undefined).
- Suite mới x3 liên tiếp: Tests: 14 passed, 14 total — Exit Code: 0 / 0 / 0.
- Full `pnpm --filter @du/worker-sdk test`: 2 failed, 16 passed, 18 suites;
  3 failed, 307 passed, 310 tests — Exit Code: 1. Cả 2 suite đỏ ĐỘC LẬP với
  code của cycle này (xem "Đỏ ngoại lai").
- M1 mutation (đổi chuỗi format AAD): ĐÚNG 2 test port-fidelity đỏ, 12 test hành vi
  vẫn xanh. Restore byte-exact: sha cc7db569, 33614 B, MUTATION_LEFT=false, 14/14
  xanh trở lại.

#### Phát hiện quan trọng từ M1 (nên đọc trước khi "dọn" port)
- 12 test hành vi KHÔNG bắt được đổi format AAD, vì chúng seal và open bằng CÙNG
  một bản port — hai vế lệch nhau vẫn khớp. Chỉ 2 test port-fidelity mới bắt.
  Nghĩa là: nếu ai đó "làm đẹp" port ở worker (đổi AAD, đổi layout nonce, đổi
  chunk size), 12 test vẫn xanh và chỉ hai service fail lúc chạy thật.
  ⇒ Hai test fidelity KHÔNG phải thừa; chúng là hợp đồng liên package duy nhất.

#### Đỏ ngoại lai (không sửa — đúng quy tắc lane)
- `tests/network-boundaries.boundary.test.ts` (2 test: mid-stream cap, sha mismatch)
  và `tests/artifact-direct-band.test.ts` (1 test RSS 64 MiB). Cả hai import
  CHỈ `artifact-streams` / `artifact-multipart` / `fan-out` — KHÔNG nạp
  `task-context.ts`, `crypto-storage.ts`, `crypto-seam.ts`, nên code của cycle này
  không thể chạy trong chúng. Kiểm chứng thêm: `artifact-direct-band` xanh 12/12 ở
  CẢ HAI lần chạy cô lập (Exit Code: 0) và đỏ khi chạy cùng full suite ⇒ nhiễu tải
  máy (RSS + real-listener timing), không phải regression. Cùng họ với Δ35.

#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ43 — port KHÔNG được "làm đẹp": mọi chi tiết wire (format AAD, layout nonce 4 byte
  + index big-endian, chunk 4 MiB, khóa MAC HKDF, error taxonomy) phải giống hệt
  orchestrator, nếu không hai service không đọc được ciphertext của nhau. Đã có test
  canh (port-fidelity). Cần một quyết định lâu dài: giữ 2 bản + test canh, hay
  tách facade ra package dùng chung (sẽ bỏ được cả 2 bản và cả test canh).
- Δ44 — chunked manifest CHƯA có đường đi: `finalizeArtifact` không có field
  manifest, nên artifact > 5 MiB chưa mã hóa được. Cần contracts + orchestrator
  (ngoài scope). Hiện tại seam TỪ CHỐI thay vì ghi plaintext.
- Δ45 — CHƯA có caller nào truyền `deps.crypto`: worker nào cũng chưa mã hóa. Seam
  opt-in nên hành vi upload hiện tại KHÔNG đổi (byte-for-byte) — an toàn, nhưng
  ENC-04 chưa đạt "no worker path writes plaintext durable" cho tới khi có wiring
  + DEK delivery (vẫn là Δ41 của Mục 18).
- Δ46 — `businesses/document-core` (6 action, step-checkpoint) CHƯA đụng tới:
  packet ghi `packages/document-core` không tồn tại, và mở scope thì mới mở
  `packages/**`, không tự động mở `businesses/**`. Checkpoint của document-core
  (`pipelines/step-checkpoint.ts`) vẫn ghi output step qua `ctx.step` — đó là
  control-plane, đã đi qua `metadata-crypto` ở Mục 17, KHÔNG phải artifact path.
  Cần packet riêng cho document-core.

#### Tự phân loại 4 tầng
- SPECIFIED: port + seam + tests rõ; phần document-core và DEK delivery vẫn ngoài.
- IMPLEMENTED: 1 port module + 1 seam module + wiring single-PUT + exports + 14 test.
- VERIFIED (offline): tsc 0; 14/14 x3 Exit 0; M1 đúng 2 test fidelity rồi restore
  byte-exact; full 307/310 với 3 đỏ ngoại lai đã chứng minh độc lập.
- ACCEPTED: không thuộc quyền lane. ENC-04 [~]: shape + binding + port fidelity đã
  có bằng chứng, nhưng Δ44 (manifest) + Δ45 (wiring/DEK) + Δ46 (document-core)
  còn mở nên chưa thể nói "không còn worker path ghi plaintext".
