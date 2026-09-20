# Infrastructure plan

Planning only. Implementation sẽ tạo Compose/config/runbooks tại đây cho Orchestrator, Connector, document-core, PostgreSQL, Redis, object storage và mock provider. Namespace/ports/volumes độc lập DUGate cũ. Không có Coordinator/Document service riêng.

Đọc [operations](../docs/12-operations.md), [P1 foundation](../tasks/P1-foundation-contracts.md), [P8 readiness](../tasks/P8-release-readiness.md). One-shot migrations, health/shutdown, backup restore và multi-replica quota tests là deliverables. Không deploy production trong scope plan.

