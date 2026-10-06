# Review code + điều chỉnh plan (markers stale + bổ sung feature gap)

**Packet:** review-plan-markers-features | **Lane:** b103836b (Claude Code) | Dispatch 2026-10-03T12:45+07:00 — **theo yêu cầu trực tiếp của user**: "review lại code, bổ sung tính năng và điều chỉnh plan".

**Bối cảnh:** `coordination/reports/tick-proposal-2026-10-03.md` chốt: (a) các marker stale S1/S2/S5 đang **làm dispatch lại việc đã xong** (tốn kém thật); (b) S3/S4/S6/S7 phụ. Đồng thời user yêu cầu rà lại code để **bổ sung tính năng còn thiếu vào plan**.

**Việc (theo thứ tự ưu tiên):**
1. **S5** — sửa 3 row khai SAI về `dispatcher.ts`: `PAR-01`, `PAR-M01` (trong `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md` nếu có), `PAR00-M01` (`tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md`). Thực tế: `dispatcher.ts:105-106` đăng ký `apikey.issue/revoke`, `:540`/`:619` implement với tenant fence (theo recon-c). Rewrite câu chữ để KHÔNG bị dispatch lại; giữ nguyên marker status, chỉ sửa nội dung stale + ghi file:line làm căn cứ.
2. **S1/S2** — re-anchor `LOCAL-01`/`LOCAL-02` (`tasks/ADMIN-LOCAL-AUTH-2026-09-30.md`): implementation ĐÃ tồn tại (`services/orchestrator/migrations/0023_admin_local_users.sql`, `src/modules/auth/admin-local/`, `src/modules/auth/local-primitives/`, `src/migrations-local-users-cli.ts`) — sửa từ "chưa có" thành "đã có implementation — acceptance chưa chứng minh (VFY-LOCAL)".
3. **S3/S4** — sửa comment manifest "host dispatch pending" cho `disbursement` + anchor tester p9-03 "not mounted or registered" theo HEAD (`document-core.manifest.ts:110,431`, `worker.ts:2000`, recipe `:448-450`).
4. **S6/S7** — ghi chú re-baseline cho bảng line-count CONV (`:3` self-warn) + `PLAN_BASELINE_COUNTS` guard `server.ts` (đo lại sau khi CONV wave chốt — chưa đổi số khi chưa chốt).
5. **Feature gap / bổ sung tính năng vào plan:** rà code hiện tại (đặc biệt các vùng CONV/RFX vừa chốt + legacy Admin journeys) → nếu có capability/invariant CHƯA được phản ánh trong plan nào (không trùng PAR/COMP/ACUI/RFX/CONV hiện có), thêm row/task mới vào plan phù hợp, kèm file:line + căn cứ. Không tạo gate mới; không tick gì.

**Ranh giới:** chỉ được sửa `du-rework/tasks/*.md` (nội dung marker/plan) + ghi receipt `du-rework/coordination/reports/review-plan-adjust-2026-10-03.md`. KHÔNG sửa code/source/test; KHÔNG commit (việc commit đang chờ user quyết riêng — không đụng); không tick gate; không chạm `nocobase-10`.
