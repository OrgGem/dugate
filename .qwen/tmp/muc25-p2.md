#### Mutation probe (chứng minh test cắn, không chỉ xanh)

Cả hai probe **đơn biến**, chạy trên file đã backup, restore byte-exact sau mỗi cái:

- **M1** — `encryption` thành **bắt buộc** (bỏ `.optional()`):
  `Tests: 1 failed, 12 passed` — đúng test `leaves a plaintext grant unchanged and unencrypted`.
  ⇒ test thật sự bảo vệ tính **opt-in**; nếu không có nó, ai đó siết field này thành bắt buộc sẽ
  làm **mọi grant plaintext vỡ** mà không có test nào kêu.
- **M2** — bỏ 2 `.refine()` byte-length (giữ nguyên `.strict()`):
  `Tests: 3 failed, 10 passed` — đúng 3 test nonce/tag: `rejects a nonce that is valid base64
  but not 12 bytes`, `rejects a tag that is not 16 bytes`, và `surfaces the failure at the GRANT`.

Hai lần tôi **làm hỏng probe trước khi probe chạy** và phải làm lại — cả hai lần đều do **chính tôi**
đo sai, không phải do schema:
1. M2 lần 1 xoá 6 dòng thay vì 8 ⇒ `.refine` tag bị bỏ dở, file **sai cú pháp**, jest báo
   `Tests: 0 total`. Tôi **không** ghi "M2 đỏ" theo kết quả đó — 0 test chạy không phải bằng chứng.
2. M2 lần 2 xoá luôn `.strict()` ⇒ 4 test đỏ thay vì 3, tức **hai biến cùng lúc**, không phải probe
   đơn biến. Đã làm lại cho sạch.
Ghi lại vì đây là lần thứ ba trong các cycle gần đây một "bằng chứng" hoá ra là artifact của lỗi
đo của chính tôi; nếu không kiểm kỹ thì tôi sẽ nộp con số sai.

#### Baseline và Verify (offline, literal exit code)
**Baseline đo TRƯỚC khi sửa** (quan trọng, vì nó không xanh):
`Test Suites: 12 failed, 8 passed, 20 total` / `Tests: 227 passed, 227 total`.
12 suite **không chạy được** do lỗi TS **có sẵn** ở file của lane Cost
(`usage-reconciliation.ts:121` `Cannot find name 'NonNegativeIntSchema'`, mtime `2026-09-28T01:22`,
`usage-budget.ts` 23:02, `pricing.ts` 22:32). Tôi **không** sửa, không hấp thụ — cũng không ghi nó
vào delta của mình.

**Sau khi sửa:**
- Suite mới: `Test Suites: 1 passed` / `Tests: 13 passed, 13 total` — Exit Code: **0**.
- `pnpm --filter @du/contracts test` FULL: **`Test Suites: 23 passed, 23 total` /
  `Tests: 462 passed, 462 total`** — Exit Code: **0**.
  ⇒ **12 lỗi TS ngoại lai đã tự hết** (lane Cost sửa file của họ trong lúc tôi làm). Tôi không
  gán công dọn đó cho mình: 20 suite baseline + 1 của tôi + 2 suite mới của lane khác = 23.
- `pnpm --filter @du/contracts exec tsc --noEmit` — Exit Code: **0**, log rỗng.
- **Typecheck hạ nghiệm (vì contracts là package dùng chung):**
  `@du/orchestrator` tsc Exit Code **0**; `@du/worker-sdk` tsc Exit Code **0**.
  Thêm field optional không phá consumer nào — đã kiểm bằng chạy thật, không suy luận.
- Restore byte-exact: `runtime.ts` sha **`71c0458e`** / 20832 B; `encryption.ts` sha **`395e0880`** /
  13973 B. `runtime.ts` giữ nguyên **CRLF** (467 CRLF / 0 LF) — file này CRLF, file kia LF, tôi đo
  từng file thay vì đoán.

#### Phần coordinator đã phán (Δ59) — GHI NHẬN, không tự mở lại
Coordinator quyết: **KHÔNG ràng buộc lease epoch vào checkpoint AAD**, để giữ idempotent replay khi
retry. Tôi đồng ý và ghi lý do để cycle sau không đề xuất ngược lại: một retry là một **lease epoch
mới**, nên nếu epoch nằm trong AAD thì checkpoint của lần trước **không mở được** ⇒ mất đúng tính
chất idempotent mà checkpoint sinh ra để có. ⇒ Δ59 **ĐÓNG** theo quyết định này. Tôi **không** thêm
gì vào `step-checkpoint.ts`.

#### Δ-DEVIATION (chờ coordinator)
- **Δ60 — hai hình DEK đang cùng tồn tại, chưa ai adjudicate.**
  `WrappedDekEnvelopeSchema` (keyId/wrappedKey/nonce/tag) và `StorageWrappedDekSchema`
  (keyRef/keyVersion/ciphertext) là hai hợp đồng **khác nhau về tên field** cho cùng một khái niệm
  "DEK đã wrap". Tôi tách để khớp runtime, nhưng về lâu dài đây là nợ kỹ thuật: một ai đó đọc
  ADR-18 sẽ hiểu nhầm shape nào áp dụng ở đâu. Cần một lane sở hữu contracts quyết: hợp nhất tên,
  hay ghi rõ bảng mapping trong `docs/15-decisions.md`. **Tôi không tự hợp nhất** vì sẽ phá wire
  với facade đang chạy.
- **Δ57 tiến 1/3.** Mục 1 (contract) **xong**. Còn:
  - (2) `packages/worker-sdk`: `sealArtifactBytes` phải trả + **persist** envelope, và read path
    phải `decrypt` khi grant có `encryption`.
  - (3) orchestrator: trả `encryption` trong grant + lưu envelope cạnh object.
  **Không mục nào trong 2-3 nằm trong write scope tôi được giao ở task này**, nên Δ57 **chưa
  đóng** và ENC-04 vẫn chưa coi là xong. Contract bây giờ đã sẵn sàng cho (2)-(3).
- **Δ44 chưa đụng** (chunked >5 MiB). `StorageEnvelopeRefSchema` cố tình **không** có trường
  manifest: manifest của runtime dùng `manifestMac` mà contract chưa đóng băng field MAC (ghi rõ
  ở `crypto-storage-facade.ts:127-129`). Thêm field manifest bây giờ là hợp đồng cho thứ chưa tồn
  tại — để Δ44.

#### Tự phân loại 4 tầng
- **SPECIFIED**: rõ, **sai 1 chi tiết** (tên file) — đã sửa bằng đo.
- **IMPLEMENTED**: 2 file src (1 file thêm schema, 1 file thêm field optional) + 1 file test mới.
- **VERIFIED (offline)**: 13/13 mới; FULL contracts 23/23 462/462 Exit 0; tsc contracts 0;
  tsc orchestrator 0; tsc worker-sdk 0; M1/M2 đơn biến đúng mục tiêu; restore byte-exact 2 file.
- **ACCEPTED**: không thuộc quyền lane. Δ57 còn mục 2-3; Δ60 cần quyết về hai hình DEK.
