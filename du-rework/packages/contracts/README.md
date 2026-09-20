# Contracts

**Planning placeholder — chưa có source/config implementation.**

## Purpose

Wire DTOs, JSON schemas/validators, standardized errors và API descriptions phiên bản hóa.

## Boundary

Pure contracts; không Next, DB, secret hoặc business dependencies.

## Planned structure

`src/{manifest,public-api,runtime,connector,queue,errors}; schemas; api; tests`

Xem [workspace structure](../../docs/03-project-structure.md). Cấu trúc trên được scaffold khi bắt đầu phase implementation, không được hiểu là đã tồn tại.

## Read first

- [04-data-state](../../docs/04-data-state.md)
- [05-business-registry](../../docs/05-business-registry.md)
- [06-public-api](../../docs/06-public-api.md)
- [07-internal-api](../../docs/07-internal-api.md)
- [08-connector-api](../../docs/08-connector-api.md)
- [09-queue-sdk](../../docs/09-queue-sdk.md)

## Task packets

- [P1-foundation-contracts](../../tasks/P1-foundation-contracts.md)

## Handoff requirements

Business/use-case doc → interfaces → function design → test cases → implementation → evidence. Source chỉ ở subproject này; shared contract/root lockfile qua integration owner. Tất cả nhiệm vụ hiện TODO.

