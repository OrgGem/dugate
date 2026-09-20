# Example Review Business

**Planning placeholder — chưa có source/config implementation.**

## Purpose

Business mẫu chứng minh registration, dynamic profile, fanout, human input và version rollover không rebuild platform.

## Boundary

Không sửa Orchestrator/Connector source để đạt extension test.

## Planned structure

`docs/business.md; src/{manifest,handlers}; src/worker.ts; tests`

Xem [workspace structure](../../docs/03-project-structure.md). Cấu trúc trên được scaffold khi bắt đầu phase implementation, không được hiểu là đã tồn tại.

## Read first

- [05-business-registry](../../docs/05-business-registry.md)
- [09-queue-sdk](../../docs/09-queue-sdk.md)
- [13-test-strategy](../../docs/13-test-strategy.md)

## Task packets

- [P7-extension-proof](../../tasks/P7-extension-proof.md)

## Handoff requirements

Business/use-case doc → interfaces → function design → test cases → implementation → evidence. Source chỉ ở subproject này; shared contract/root lockfile qua integration owner. Tất cả nhiệm vụ hiện TODO.

