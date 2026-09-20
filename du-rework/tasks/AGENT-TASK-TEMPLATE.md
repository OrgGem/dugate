# Agent task packet template

Copy template này vào task assignment khi người dùng yêu cầu implementation. Không tự spawn agent chỉ vì template tồn tại.

## Objective

- Task ID / phase:
- Outcome và acceptance criteria:
- Status: TODO
- Prerequisites đã đạt / evidence:

## Read first

- du-rework README, product-scope, architecture, project-structure.
- Spec và Test IDs của packet.
- Contract version/digest đã freeze.
- Existing repository chỉ read-only reference; không lấy .env/documents thật.

## Ownership

- Allowed write paths:
- Read-only dependencies:
- Shared files cần integration owner:
- Explicit non-goals:

## Work sequence

- [ ] BRD/scenario và edge cases đủ rõ.
- [ ] Structure/interface/function signatures được thống nhất.
- [ ] Test fixtures và observable assertions trước implementation.
- [ ] Implement smallest complete behavior trong assigned paths.
- [ ] Unit/contract tests pass; integration với real provider component khi ready.
- [ ] Lint/typecheck; UI screenshots nếu áp dụng.
- [ ] Spec/doc changes đồng bộ; không tự đổi wire contract.

## Handoff format

Outcome; changed paths; schema/API changes; tests + actual results; remaining limitations; required next task IDs. Không tuyên bố tests pass nếu chưa chạy, không dùng stub-only evidence thay cho integration evidence.
