# Worker SDK

**Planning placeholder — chưa có source/config implementation.**

## Purpose

Business registration/lifecycle, claim/lease, checkpoints, child tasks, human waits, artifacts và invocation grants.

## Boundary

Chỉ contract + queue/HTTP dependencies, không platform source/DB.

## Planned structure

`src/{runtime-client,lifecycle,task-context,steps,artifacts,errors}; tests`

Xem [workspace structure](../../docs/03-project-structure.md). Cấu trúc trên được scaffold khi bắt đầu phase implementation, không được hiểu là đã tồn tại.

## Read first

- [04-data-state](../../docs/04-data-state.md)
- [07-internal-api](../../docs/07-internal-api.md)
- [09-queue-sdk](../../docs/09-queue-sdk.md)

## Task packets

- [P4-worker-sdk](../../tasks/P4-worker-sdk.md)

## Handoff requirements

Business/use-case doc → interfaces → function design → test cases → implementation → evidence. Source chỉ ở subproject này; shared contract/root lockfile qua integration owner. Tất cả nhiệm vụ hiện TODO.

