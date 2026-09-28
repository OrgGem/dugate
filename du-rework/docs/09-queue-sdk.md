# Queue protocol, interfaces và function inventory

## Queue contract

Queue root và child cùng business: `du-business-{businessId}-{exactVersion}`. Chỉ registered worker version đúng được consume. Redis ACL/provisioning theo queue prefix được kiểm chứng bằng integration test; service HTTP identity không tự bảo vệ Redis nếu cấp credential quá rộng.

```ts
// Specification only; fields serialized as JSON.
interface BusinessJobV1 {
  contractVersion: '1';
  deliveryId: string;
  taskId: string;
  operationId: string;
  businessId: string;
  businessVersion: string;
  action: string;
  kind: string;
  correlationId: string;
}
```

Job payload không chứa file bytes, raw prompt lớn, provider secret, signed URL dài hạn hoặc toàn bộ checkpoint. Runtime HTTP trả scoped refs sau claim. Job ID stable từ outbox/delivery ID, không phụ thuộc BullMQ auto-removal để bảo đảm dedup lâu dài.

Queue dùng vận chuyển at-least-once. Business retry do runtime quản lý; delivery lại chỉ claim nếu task lease/state cho phép. Failed queue jobs phục vụ transport diagnosis, không thay thế terminal business records. Retention/DLQ policy có giới hạn và manual replay có audit.

## SDK public interfaces dự kiến

```ts
interface BusinessDefinition {
  manifest: BusinessManifest;
  handlers: Record<string, TaskHandler>;
}
type TaskHandler = (ctx: TaskContext) => Promise<TaskDisposition>;
type TaskDisposition =
  | { kind: 'completed'; resultRef: ArtifactRef }
  | { kind: 'waiting-children' }
  | { kind: 'waiting-input'; waitId: string }
  | { kind: 'retry-scheduled' };
```

TaskContext cung cấp identity, snapshot, deadline, AbortSignal, checkpoints và các facade dưới đây. DTO/schema đã được materialize trong `@du/contracts` (gate `contracts-v1` READY) và facade/worker lifecycle trong `@du/worker-sdk` (gate `sdk-ready` READY). Spawn/HITL/artifact/grant surface có unit evidence nhưng endpoint Orchestrator và cross-service E2E tương ứng vẫn chưa đầy đủ.

## Functions và responsibilities

| Module/function | Input → output | Side effects/invariants | Test IDs |
|---|---|---|---|
| Registry.validateManifest | unknown → valid manifest/problem | Pure; schema size/ref guard | REG-01..04 |
| Registry.registerVersion | identity,manifest → registration | Immutable digest, disabled default | REG-01..04 |
| Profiles.resolveExecution | auth,business,action,input → snapshot | Lock enforcement, pin revisions | PRF-01..03 |
| Operations.submit | scope,request,key → operation | Atomic idempotency+operation+outbox | OPS-01..03 |
| Runtime.claimTask | task,identity,delivery → lease | Atomic CAS, fence old attempts | RUN-01..03 |
| Runtime.saveStep | lease,stepKey,inputHash,refs → checkpoint | Full output; duplicate equality | RUN-04 |
| Runtime.spawnAndWait | lease,children,join → wait state | Atomic child+outbox+parent wait | RUN-05 |
| Runtime.resume | actor,waitId,input,version → operation | Exactly one accepted resume | RUN-06 |
| Runtime.complete/fail | lease,result/error → task state | Terminal monotonicity, retry budget | RUN-02..03 |
| Outbox.dispatchBatch | due rows → dispatch report | Stable job IDs, crash replay | OPS-02 |
| Reconciler.recover | expired leases/pending records → repairs | No blind duplicate inference | RUN-03,CON-03 |
| SDK.defineBusiness | manifest,handlers → definition | Validate handler kinds | REG-04 |
| SDK.startWorker | definition,config → lifecycle handle | Register, heartbeat, consume, shutdown | EXT-01,RUN-01 |
| ctx.step | stepKey,inputHash,fn → outputRef | Read success or execute+persist; no preview resume | RUN-04 |
| ctx.spawnAndWait | children,join,continuation → disposition | Parent yields; no blocking join | RUN-05 |
| ctx.waitForInput | waitKey,schema,context → disposition | Persist schema/results then release | RUN-06 |
| ctx.connector.invoke | slot,input,options → invocation result | Runtime grant; stable invocation ID | CON-01..04 |
| ctx.artifacts.read/write | authorized refs/stream → stream/ref | Streaming limits/hash/finalize | ART-01..03 |
| DocumentKit.detect/parse | artifact stream,format → document | No provider/config access | DOC-01 |
| DocumentKit.convert/archive | structured content,format → artifact | Safe paths/size limits | DOC-04,ART-03 |
| Connector.invoke | grant,request → result/pending/error | Ledger/quota/provider adapter | CON-01..05 |
| Usage.ingest | signed events → accepted IDs | Unique debit per event | USE-01..02 |
| Webhook.deliver | delivery → status | Signature/backoff/dedup ID | OPS-06 |

Function signatures chi tiết được owner viết interface-first với Result/error types, cancellation behavior và tests. Không dùng `any`; external values là `unknown` qua schema validation.

## Partial outages

- Runtime unavailable trước claim: không gọi provider; queue delivery retry bounded transport policy.
- Runtime unavailable sau provider success: Connector ledger giữ kết quả; replay invocationId lấy lại, task không complete trước checkpoint durable.
- Redis unavailable: submit chỉ trả accepted nếu DB outbox durable và admission policy cho phép backlog; otherwise 503 trước acceptance. Recovery dispatcher đảm nhiệm enqueue.
- Worker bị kill: expired lease dẫn delivery mới; completed checkpoints đọc lại; UNKNOWN invocation được reconcile.
- Orchestrator restart: registry/snapshot/tasks ở PostgreSQL; outbox/join/input timers hồi phục từ DB.

## BullMQ reference boundary

Thiết kế v1 dùng durable runtime state + continuation jobs để giữ control-plane generic. BullMQ waiting-children là lựa chọn adapter có thể khảo sát, không được trộn hai nguồn dependency state tùy agent. Cơ chế parent nhường slot có tham khảo [BullMQ Process Step Jobs](https://docs.bullmq.io/patterns/process-step-jobs); nguyên tắc retry có tham khảo [Idempotent Jobs](https://docs.bullmq.io/patterns/idempotent-jobs). P1 xác minh trên phiên bản pinned; chưa áp dụng API mới chỉ vì docs latest có.
