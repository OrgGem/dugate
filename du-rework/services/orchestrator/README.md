# Orchestrator

**Planning placeholder — chưa có source/config implementation.**

## Purpose

Public API, Admin, Registry, Profile và generic background runtime trong cùng service role.

## Boundary

Không chứa code business, native parser, provider adapters; không import source project cũ.

## Planned structure

`src/server, src/app, src/modules/{auth,registry,profiles,operations,runtime,artifacts,outbox,usage,webhooks,audit}, src/db, tests`

Xem [workspace structure](../../docs/03-project-structure.md). Cấu trúc trên được scaffold khi bắt đầu phase implementation, không được hiểu là đã tồn tại.

## Read first

- [02-architecture](../../docs/02-architecture.md)
- [04-data-state](../../docs/04-data-state.md)
- [06-public-api](../../docs/06-public-api.md)
- [07-internal-api](../../docs/07-internal-api.md)
- [11-admin-ux](../../docs/11-admin-ux.md)

## Task packets

- [P2-orchestrator](../../tasks/P2-orchestrator.md)
- [P6-admin](../../tasks/P6-admin.md)

## Handoff requirements

Business/use-case doc → interfaces → function design → test cases → implementation → evidence. Source chỉ ở subproject này; shared contract/root lockfile qua integration owner. Tất cả nhiệm vụ hiện TODO.

