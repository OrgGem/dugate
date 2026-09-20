# Connector Client

**Planning placeholder — chưa có source/config implementation.**

## Purpose

Typed invocation, replay, pending/poll, error handling và cancellation facade.

## Boundary

Không implement provider adapter trong client; retry không vượt policy runtime.

## Planned structure

`src/{client,types,errors}; tests`

Xem [workspace structure](../../docs/03-project-structure.md). Cấu trúc trên được scaffold khi bắt đầu phase implementation, không được hiểu là đã tồn tại.

## Read first

- [08-connector-api](../../docs/08-connector-api.md)
- [09-queue-sdk](../../docs/09-queue-sdk.md)

## Task packets

- [P3-connector](../../tasks/P3-connector.md)

## Handoff requirements

Business/use-case doc → interfaces → function design → test cases → implementation → evidence. Source chỉ ở subproject này; shared contract/root lockfile qua integration owner. Tất cả nhiệm vụ hiện TODO.

