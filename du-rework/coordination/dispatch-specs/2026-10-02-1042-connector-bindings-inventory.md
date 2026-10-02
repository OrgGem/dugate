# Connector task-name / slot bindings inventory (READ-ONLY) — cho 3 workflow P9

## Bối cảnh

Spec integration `coordination/reports/codex-p9-workflow-integration-spec-2026-10-02.md` §3 + §5-Q5 xác định:
connector bindings là một trong các open questions chặn wave integration. D5 probe cũng để OPEN phần
`doc_compare_structure` / `doc_compare_references`. Task này thu thập bằng chứng read-only để trả lời.

## Mục tiêu

1. Với **disbursement** (`businesses/document-core/src/worker.ts` quanh `:877,913,943,979`): 4 task value
   `disbursement_classify|extract|crosscheck|report` — chúng đến từ đâu (connector profile? slot binding?
   manifest?), và connector nào (registry/config) cần có để chúng resolve?
2. Với **lc-checker** (`businesses/lc-checker/src/manifest.ts:172-197` + worker): 4 slot yêu cầu
   `ocr|vision|crosscheck|report` — connector hiện đăng ký những slot/task nào?
3. Với **doc-compare**: `DEFAULT_DOC_COMPARE_BINDING` defaults `doc_compare_structure|references` —
   connector có task/slot tương ứng không, hay chưa?
4. Đối chiếu `services/connector/**` (registry/adapters/config/migrations — read-only) + packages/contracts
   connector schemas + bất kỳ seed/fixture connector nào: **bảng `business → cần gì → connector có gì → verdict`**.
5. Kết luận: cái nào đã có, cái nào OPEN (kèm nơi cần đăng ký — không tự sửa).

## Ranh giới

- READ-ONLY: chỉ ghi `coordination/reports/qwen-connector-bindings-inventory-2026-10-02.md`; không sửa source/test/config;
  không chạy infra; không tick gate; không commit.
- KHÔNG đụng `document-core/**` (qwen_4 đang giữ cho D5) — chỉ đọc.
- Không nhắm `nocobase-10`; không quét space nocobase.

## Acceptance

- Bảng bindings đầy đủ 3 business + verdict OPEN/PRESENT từng dòng, file:line cho mọi kết luận.
- Nêu rõ giới hạn: đọc code/config tĩnh, không phải live registry state.
