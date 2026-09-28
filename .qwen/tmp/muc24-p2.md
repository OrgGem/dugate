#### Baseline đo được TRƯỚC khi kết luận (không sửa gì)
- `pnpm --filter @du/document-core test`: **46/46 suite, 542/542 test, Exit Code 0**.
- `pnpm --filter @du/worker-sdk test`: **18/18 suite, 311/311 test, Exit Code 0**.
  (18 + 1 suite mới của tôi = 19; xem Verify.)

#### Verify (offline, literal exit code)
- Proof suite mới: `Tests: 1 passed, 1 total` — Exit Code: **0**.
- `pnpm --filter @du/worker-sdk test` (full, **có** suite proof của tôi):
  `Test Suites: 19 passed, 19 total` / `Tests: 312 passed, 312 total` — Exit Code: **0**.
- `pnpm --filter @du/document-core test` (full): **46/46, 542/542** — Exit Code: **0**.
- `tsc --noEmit` cả 2 package: Exit Code **0** (xem bảng dưới).

#### File tôi thêm / file tôi KHÔNG đụng
- THÊM: `packages/worker-sdk/tests/enc-read-roundtrip-proof.test.ts` (test chứng minh, không sửa logic).
- KHÔNG đụng: `src/actions/**`, `src/worker.ts`, `src/pipelines/step-checkpoint.ts`,
  `src/types/context.ts`, và **không sửa** `task-context.ts` / `crypto-*.ts` của worker-sdk.
  Lý do: sửa read path cần contract thay đổi ở 3 package (Δ57), nằm ngoài scope.

#### Δ-DEVIATION (chờ coordinator adjudicate — đây là phần cần quyết)
- **Δ57 — BLOCKER, cần phạm vi mới.** Round-trip artifact hỏng khi bật seam. Sửa đúng cần:
  (1) `packages/contracts`: thêm trường envelope vào `ArtifactAccessGrantSchema` (+ `EncryptedChunkManifest`
  cho >5 MiB, vẫn là Δ44); (2) `packages/worker-sdk`: `sealArtifactBytes` trả về và **persist**
  `EncryptedStorageObject` (nonce/tag/aad/dek), và read path phải `decrypt` khi grant nói object là
  encrypted; (3) orchestrator: trả envelope trong grant + lưu cạnh object. **Không lane nào tôi
  được giao đang giữ cả 3.** Cho tôi scope này hoặc giao lane khác — hiện tại ENC-04 **không thể
  coi là xong**.
- **Δ58 — cần quyết định, không phải sửa code.** (a) và (c) hiện **mâu thuẫn nhau**: checkpoint đã seal
  (cycle 20) nhưng artifact chưa seal ở tầng đọc ⇒ một hệ thống vừa "bảo mật" vừa "hỏng". Nếu bật
  seam ở production, checkpoint vẫn đọc lại được (nó tự mang envelope) còn artifact thì không.
  ⇒ **không bật seam cho tới khi Δ57 xong** — điều này cũng làm Δ45 (chưa deployment nào bật seam)
  hoá ra là **tình trạng đúng**, không phải sự trễ chưa làm.
- **Δ59 — checkpoint lease.** Muốn validate lease ở document-core thì adapter phải mang
  `leaseEpoch` / `leaseExpiresAt` từ `ClaimedTask` vào `TaskContext`, và checkpoint phải **ràng
  buộc epoch vào binding AAD** để checkpoint của lease cũ không mở được dưới lease mới. Đó là
  thay đổi ở `types/context.ts` + `worker.ts` + `step-checkpoint.ts` **và** phải khớp với policy
  orchestrator (lease fence ở Mục 11). Tôi chưa làm vì cần coordinator chốt: ràng buộc epoch vào AAD
  có làm hỏng replay sau retry không? (Retry = lease epoch mới; nếu AAD gồm epoch thì checkpoint cũ
  không mở được ⇒ mất idempotent replay.) **Đây là câu hỏi thiết kế, tôi không tự quyết.**

#### Tự phân loại 4 tầng
- **SPECIFIED**: rõ về ý, nhưng **2/3 mệnh đề không thể đạt ở write scope đã giao**.
- **IMPLEMENTED**: 0 file sản phẩm. 1 file test chứng minh.
- **VERIFIED (offline)**: doc-core 46/46 542/542 Exit 0; worker-sdk 19/19 312/312 Exit 0;
  proof 1/1 Exit 0; tsc 0.
- **ACCEPTED**: không thuộc quyền lane. Δ57 (round-trip) và Δ59 (lease binding) cần coordinator
  adjudicate trước khi ENC-04 được coi là đóng.
