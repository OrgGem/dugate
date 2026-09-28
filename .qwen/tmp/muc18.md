
---

## 18 — CYCLE 18: W-ENC-04-WORKER-SDK BLOCKED (task_fb6bd3a9e44d, ctx_cd237f470150)

#### Quyết định
- Operator chọn: **thu hồi dispatch**. Lane KHÔNG viết dòng code cho ENC-04.
- Mục này ghi lại bằng chứng chặn để packet sau đổi scope có thể đi tiếp ngay, và để
  không ai re-dispatch nguyên xiên khi chưa mở đúng ba dependency đã nêu dưới.
- **Không có file nào bị sửa ở cycle này.**

#### Bằng chứng chặn (4 mục, đều chạy lệnh, không suy luận)
1. **Crypto facade không nằm trong scope.** `CryptoStorageFacade` tồn tại và đã
   VERIFIED-OFFLINE tại `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts`
   (ENC-03, task_82858d64c949; board: tasks/APP-ENCRYPTION-2026-09-27.md:25). Worker-SDK
   không có `src/crypto/` (ENOENT). Packet yêu cầu "stream through crypto facade" nhưng
   facade nằm ở orchestrator — dùng nó nghĩa là import chéo package.
2. **Import chéo là bất khả thi, không phải thói quen.** `packages/worker-sdk/package.json`
   chỉ phụ thuộc `@du/contracts`, `@du/egress`, `@du/observability`, `bullmq` — không có
   orchestrator. `tsconfig.json`: `rootDir: src`, `include: ["src/**/*.ts"]`. Ba chỗ trong
   worker-sdk nhắc `services/orchestrator` chỉ là COMMENT trong docblock
   (source-ingestion.ts:16, artifact-streams.ts:301, artifact-multipart.ts:27) — tôi đã
   grep xác minh, không có import thật.
   => Muốn dùng facade: phải PORT (~860 dòng) sang worker-sdk, hoặc tách ra package
   dùng chung. Cả hai đều nằm ngoài `packages/worker-sdk/**` + `packages/document-core/**`.
3. **Worker chưa có đường nhận DEK.** Grep `packages/contracts/src/runtime.ts` với
   `dek` và `KeyRef`: **0 dòng khớp** — `ClaimResultSchema` không mang field khóa nào.
   ADR-18 + ENC-02 quy định Vault Transit giữ khóa và app không bao giờ nhận raw master
   key, nên worker phải nhận DEK qua một đường contract (orchestrator + contracts) —
   ngoài scope. Đây KHÔNG phải chi tiết hình thức: thiếu nó thì worker không thể mã
   hóa bất cứ thứ gì.
4. **Đường dẫn trong packet không tồn tại.** `packages/document-core` = false;
   `businesses/document-core` = true. Nếu lane làm đúng chữ nghĩa sẽ không sửa được file
   nào của document-core. (Đúng như memory lane DATA: doc-core ở `businesses/`.)

#### Cách mở ENC-04 (đề xuất cho coordinator, không tự làm)
Cần MỞ SCOPE trước, theo thứ tự phụ thuộc:
- (a) Chọn chỗ ở của facade: tách `crypto-storage-facade` ra package dùng chung (sạch nhất,
  orchestrator + worker-sdk dùng chung MỘT bản) HOẶC port bản worker-side. Tác động:
  orchestrator phải sửa theo nếu tách. Đây là quyết định kiến trúc, không phải của lane.
- (b) Chốt cơ chế DEK delivery: mở rộng `ClaimResultSchema` (contracts) + claim
  (orchestrator), HOẶC seam tiêm qua `TaskContextDeps` (worker-side, opt-in, không đổi
  contract). Operator đã chọn phương án seam trong câu hỏi này — nhưng nó **vẫn cần**
  một quyết định ở packet kế tiếp vì nó chặn việc chứng minh "worker mã hóa thật"
  (offline chỉ chứng minh được shape + round-trip với DEK giả).
- (c) Sửa đường dẫn packet: `packages/document-core/**` → `businesses/document-core/**`.
- Chỉ khi (a)+(b)+(c) xong, dispatch lại ENC-04 thì mọi dòng "stream through crypto
  facade / không worker path ghi plaintext durable" mới kiểm chứng được.

#### Trạng thái các task liên quan (đọc từ board, không suy luận)
- ENC-01 schema `[~]`, ENC-02 transit `[~]`, ENC-03 facade `[~]`, ENC-06 registry `[~]`,
  ENC-07 delivery — đều VERIFIED-OFFLINE theo board.
- **ENC-04 vẫn `[ ]`** — không code, không test, không receipt nhận việc.
- Ghi chú: `metadata-crypto.ts` của cycle 17 là control-plane (runtime), KHÔNG phải
  artifact-path; nó không thay thế được facade cho worker. Không được tính nhầm 2 tầng này.

#### Tự phân loại 4 tầng
- SPECIFIED: mục tiêu rõ; nhưng 3 dependency nằm ngoài write scope nên packet không
  thi hành được như giao.
- IMPLEMENTED: **không có** (theo quyết định của operator).
- VERIFIED: 4 luận điểm chặn, mỗi cái một lệnh đo; 0 file bị sửa.
- ACCEPTED: không thuộc quyền lane. ENC-04 `[ ]`, chờ packet mở scope.
