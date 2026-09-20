# System verification plan

Planning only. Cross-service contract/E2E/fault/security/load/browser tests sẽ nằm tại đây; unit tests đặt gần subproject sở hữu. Không có executable test trong bước hiện tại.

Đọc [test catalog](../docs/13-test-strategy.md), [P7 extension](../tasks/P7-extension-proof.md), [P8 readiness](../tasks/P8-release-readiness.md). Mọi test dùng synthetic fixtures và mock provider, DB/Redis/object storage riêng. Report actual results và environment; không claim tests pass từ bản kế hoạch.
