# Observability

**Planning placeholder — chưa có source/config implementation.**

## Purpose

Structured logger, correlation helpers và bounded metric interfaces dùng chung.

## Boundary

Không log secrets/raw prompts/documents mặc định; không service business logic.

## Planned structure

`src/{logger,tracing,metrics,redaction}; tests`

Xem [workspace structure](../../docs/03-project-structure.md). Cấu trúc trên được scaffold khi bắt đầu phase implementation, không được hiểu là đã tồn tại.

## Read first

- [09-queue-sdk](../../docs/09-queue-sdk.md)
- [12-operations](../../docs/12-operations.md)

## Task packets

- [P1-foundation-contracts](../../tasks/P1-foundation-contracts.md)

## Handoff requirements

Business/use-case doc → interfaces → function design → test cases → implementation → evidence. Source chỉ ở subproject này; shared contract/root lockfile qua integration owner. Tất cả nhiệm vụ hiện TODO.

