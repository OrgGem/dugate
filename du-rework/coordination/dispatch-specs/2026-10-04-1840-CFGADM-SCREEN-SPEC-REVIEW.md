# Dispatch spec — CFGADM screen-spec review (Antigravity, read-only) — 2026-10-04 18:40 +07

- **Owner:** antigravity — `term_ae2d7e42-8042-4b85-95d5-cabed5ee3191`
- **Run:** `run_069ecd6957cd` · Nguồn: `coordination/reports/plan-review-730-2026-10-04.md` §3 (note cuối bảng: "Antigravity có thể nhận screen-spec review CFGADM Settings/Connectors/Workflow (write receipt riêng, read source), không gọi UI_APPROVED trước integrated build+browser").

## Mục tiêu

Pre-implementation **screen-spec review** cho các journey CFGADM trọng yếu, đối chiếu kế hoạch ↔ hiện trạng UI:
- **Settings 17-key surface** (mapping 17 settings root → UI fields, apply/rollback semantics);
- **Connectors** — đặc biệt **Import cURL (CFGADM-07)** đang được qwen_5 làm parser/component (`apps/admin-web/src/features/connectors/curl-import.ts`, `curl-import-preview.tsx`) — cần handoff rõ: preview model, trạng thái lỗi, chỗ sẽ mount sau này;
- **Workflow mappings**.

Nguồn đọc: `tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md` + `apps/admin-web/src/features/{settings,connectors}/**` + `docs/admin-ui-development-contract.md` (§5) + token một-nguồn (không palette/scale thứ hai).

## Deliverable

- Receipt **MỚI**: `coordination/reports/cfgadm-screen-spec-review-2026-10-04.md` — mỗi journey: hiện có gì / thiếu gì / **yêu cầu UI contract cho slice kế tiếp** (đặc biệt cho component curl-import của qwen_5) / rủi ro.

## Verdict & constraints

- **KHÔNG UI_APPROVED** — đây chỉ là screen-spec review; verdict `UI_APPROVED` chỉ sau integrated build + browser evidence theo §5.
- Read source được phép; **chỉ ghi receipt** — không sửa source/plan/task; không commit/push.
- Có thể interleave với nhịp giám sát 30' của bạn (ưu tiên packet này khi rảnh slot).
- Δ-DEVIATION flag nếu phát hiện xung đột spec.
