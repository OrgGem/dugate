# Agent task packet template

Copy template này vào task assignment khi người dùng yêu cầu implementation. Không tự spawn agent chỉ vì template tồn tại.

## Objective

- Task ID / phase:
- Outcome và acceptance criteria:
- Status: TODO
- Prerequisites đã đạt / evidence:
- Spec/ADR và contract version liên quan:
- Luồng bị ảnh hưởng (entrypoint → service → state/queue → consumer → output):
- Mismatch hiện có (expected/actual, file:line), nếu có:

## Read first

- du-rework README, product-scope, architecture, project-structure.
- Spec và Test IDs của packet.
- Contract version/digest đã freeze.
- Existing repository chỉ read-only reference; không lấy .env/documents thật.

## Ownership

- Allowed write paths:
- Read-only dependencies:
- Shared files cần integration owner:
- Dev resource namespace (database/schema, Redis DB/prefix, S3 bucket/prefix, Vault test path):
- Explicit non-goals:

## Work sequence

- [ ] Minimum behavior, security invariants và producer/consumer interface đủ rõ; decision chưa chốt ghi thành blocker riêng, không chặn module độc lập.
- [ ] Structure/interface/function signatures và write lease được thống nhất.
- [ ] Focused fixtures và observable assertions cho phần implementation đang giao.
- [ ] Implement smallest complete behavior trong assigned paths.
- [ ] Focused unit/contract/security smoke pass; integration nghiệp vụ/live chi tiết chuyển packet `VFY-*` riêng khi vertical slice sẵn sàng.
- [ ] Lint/typecheck; UI screenshots nếu áp dụng.
- [ ] Spec/doc changes đồng bộ; không tự đổi wire contract.
- [ ] Producer và consumer của contract/state mới có test tương ứng.
- [ ] Ghi rõ `IMPLEMENTED`, `VFY-*` pending và acceptance/live gate còn mở; không tick parent từ smoke.

## Handoff format

Outcome; changed paths; schema/API changes; spec/traceability IDs; tests + lệnh/cwd/exit/passed/failed/skipped + raw receipt; remaining limitations; required next task IDs. Không tuyên bố tests pass nếu chưa chạy, không dùng stub-only evidence thay cho integration evidence. Điều phối viên chỉ tick `[x]` sau khi đối chiếu full acceptance theo `du-rework/AGENTS.md`.
