# 38. MM-05 — Queue Integrity Probe & Redis-loss READY Reconstruction (DESIGN)

**Document Version:** 1.0.0
**Date:** 2026-09-25 03:27 (+07)
**Lane:** Qwen-2 (functional testing, offline) — packet ORCHESTRATOR TURN 3-B
**Status:** IMPLEMENTED (Qwen-1, src 03:57-03:58 / dist 04:04, 25/09 — Qwen-2 verify offline: sweep 8/8 + probe 4/4 exit 0) + suite live p8-02c đã đồng bộ API thật; chờ bằng chứng sống: vòng 7 (A6fb8) + vòng 8 (flip MM-05c). Bản gốc: DESIGN packet TURN 3-B.
**Related:** MM-05 (PLAN-MISMATCH), P8-02 [~], RUN-02..07, OPS-01 (outbox), OPS-07 (health/drain), docs 04/09/12/13/17, `docs/29` vòng 5/6, `docs/35` row 10/13 + R14

---

## 1. Vấn đề (bằng chứng on-disk, giờ tươi)

Chuỗi dispatch: submit → `tasks.state='READY'` + outbox row `task.dispatch` → dispatcher publish BullMQ (jobId = `jobIdForDelivery(delivery_id)`) → stamp `outbox.dispatched_at` → worker claim (READY→RUNNING, epoch+1).

Hổng MM-05 nằm GIỮA đường này — mất Redis sau dispatch, trước claim:

| Mắt xích | File:line | Hệ quả khi Redis wipe |
|---|---|---|
| Dispatcher chỉ chọn row CHƯA dispatch | `orchestrator/services/orchestrator/src/modules/queue/dispatcher.ts` SELECT `WHERE dispatched_at IS NULL` | Row đã stamp KHÔNG BAO GIỜ được publish lại → job mất vĩnh viễn trên queue |
| Recovery chỉ quét RUNNING hết lease | `runtime.ts` `sweepExpiredLeases` (~:812-839): `WHERE t.state='RUNNING' AND lease_expires_at < now()` | Task READY leaseless nằm NGOÀI scope sweep (runtime.test.ts W30-C pin: "READY task with NULL lease is excluded") |
| Deadline sweep = escape hatch manual | `server.ts:1131-1151` admin `POST /operations/sweep-deadlines` → `lifecycle.sweepDeadlines` | Operation chết dần → TIMED_OUT, dù PG state-of-record còn nguyên |
| /health chỉ báo connectivity | `server.ts:453-484` `{status,db,redis,activeLeases}` | Queue rỗng mà vẫn `ok` → MM-05c (p8-02b:288-310) đang characterization chính gap này |

Acceptance gốc (FULL-REWORK-REVIEW-FOLLOWUP:56): "MM-05 phải tái tạo job READY sau Redis loss và báo durable health trung thực; forced deadline→TIMED_OUT chỉ là escape hatch."

## 2. Định nghĩa orphan candidate (predicate phát hiện — chỉ dùng PG)

Một delivery là **orphan nghi ngờ** khi:

```sql
SELECT c.* FROM (
  SELECT DISTINCT ON (ob.aggregate_id)
         ob.id AS outbox_id, ob.delivery_id, ob.dispatched_at,
         t.id AS task_id, t.state AS task_state
  FROM outbox ob
  JOIN tasks t      ON t.id = ob.aggregate_id
  JOIN operations o ON o.id = t.operation_id
  WHERE ob.type = 'task.dispatch'
    AND ob.dispatched_at IS NOT NULL                      -- đã publish (dispatcher im lặng mãi mãi)
    AND ob.dispatched_at < now() - ($1 * interval '1 ms') -- grace: bỏ qua window claim bình thường
    AND t.state IN ('READY','QUEUED')                     -- chưa claim, không RETRY_PENDING/WAITING_*
    AND (t.lease_expires_at IS NULL OR t.lease_expires_at < now())
    AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
  ORDER BY ob.aggregate_id, ob.dispatched_at DESC         -- chỉ delivery mới nhất của task
) c
ORDER BY c.dispatched_at
LIMIT $2;
```

Xác nhận phía Redis (nguồn chân lý duy nhất cho "job còn sống"): `const job = await queue.getJob(jobIdForDelivery(c.delivery_id))` — BullMQ v5 trả `undefined` khi job không tồn tại (p8-02b header note). **Chỉ reconstruct khi `job === undefined`.** Các state `waiting/delayed/active/completed` để nguyên — `active` + task READY = worker vừa dequeue chưa kịp claim, sẽ tự hội tụ; `completed` + task READY là race fenced (xem §5).

Offline proof (4/4 exit 0, `orchestrator/services/orchestrator/tests/mm05-queue-integrity-offline.functional.test.ts`):
- probe/1 pin đúng gap dispatcher.ts (wipe → dispatchOnce()=0, không republish);
- probe/3 pin PG đủ cột để enumerate orphan mà không cần sổ sách phía Redis.

## 3. Cơ chế tái tạo (quyết định thiết kế: RE-ARM hàng gốc)

`sweepQueueIntegrity()` với mỗi candidate được xác nhận:

```sql
UPDATE outbox
SET dispatched_at = NULL,
    due_at = now() + (LEAST(power(2, attempts), 300) * interval '1 second'), -- backoff chống loop
    claim_until = NULL,
    attempts = attempts + 1
WHERE id = $1;
```

Dispatcher hiện hữu (KHÔNG đổi code publish) sẽ republish ở chu kỳ kế. Vì jobId tất định theo delivery_id:

- Republish khi job thật sự mất → job sống lại, worker claim bình thường → READY→RUNNING.
- Republish khi job VẪN còn (false-positive race, 2 replica cùng re-arm) → `queue.add` throw `already exists` → dispatcher branch hiện hữu stamp lại `dispatched_at` → **zero duplicate job, zero duplicate effect**. (probe/2 pin invariant này bằng dispatcher THẬT.)

**Phương án B đã xét — CẤM reject:** chèn delivery mới `${taskId}:requeue:${n}` → jobId mới vượt qua dedup tầng queue, mọi hội tụ dồn hết vào claim fence, thêm churn dòng outbox + delivery id mới lộ ra worker. Phương án A strictly ít xâm lấn: không migration, không sửa schema, không sửa dispatcher, multi-replica-safe không cần lock.

## 4. Schedule + knobs

- Móc vào `recoveryTimer` hiện hữu (server.ts:358-362) — cùng cadence với expired-lease sweep, TỈNH sẵn pattern production-hook:
  ```ts
  recoveryTimer = setInterval(() => {
    runtime.sweepExpiredLeases().catch(() => undefined);
    runtime.sweepQueueIntegrity().catch(() => undefined); // MM-05 mới
  }, recoveryIntervalMs);
  ```
- `QUEUE_INTEGRITY_GRACE_MS` default **30_000** (≫ dispatch poll 2s + claim RTT; một chu kỳ test DB-window không bị race chính grace).
- `QUEUE_INTEGRITY_BATCH` default **50** (trần Redis getJob/cycle; wipe toàn bộ queue tái tạo dần theo cadence — throughput đủ vì chỉ backoff nhân bản số job bị mất).
- Bật khi `autoDispatch` bật; tests drive `sweepQueueIntegrity()` trực tiếp như `sweepExpiredLeases` (test-seam parity).

## 5. Fencing & invariant KHÔNG được phá

| Bất biến | Bằng chứng giữ |
|---|---|
| Claim là fencing authority (RUN-02/03/04) | job cũ sống lại chỉ 1 claim thắng (epoch bump, `last_delivery_id`); p8-02-fault-recovery §4 "Duplicate Delivery Converges to One Effect" phải còn xanh |
| Không revive task/op terminal | predicate loại state terminal + op terminal (§2) — đồng bộ guard RUN-07/§31 |
| Không đụng RETRY_PENDING/delayed | predicate chỉ READY/QUEUED; retry backoff của failTask giữ nguyên |
| Lease RUNNING mồ côi vẫn do sweepExpiredLeases lo | hai sweep độc lập, không chồng candidate set (RUNNING ∉ READY/QUEUED) |
| Escalation cap | `attempts` đã có sẵn cột; khi `attempts >= QUEUE_INTEGRITY_MAX_ATTEMPTS` (default 10) → NGỪNG re-arm, đánh dấu health SUSPECT + audit warn `queue.integrity_stalled` (KHÔNG tự FAILED — chính sách terminal = quyền platform/coordinator, decision D1) |

## 6. Durable health (chốt nốt MM-05c)

Sweep cache kết quả mới nhất vào ctx (in-memory, một slot):

```json
"queueIntegrity": { "state": "OK | RECONSTRUCTING | SUSPECT", "orphansLast": 2, "stalled": 0, "lastSweepAt": "<iso>" }
```

- `OK`: kỳ sweep gần nhất không orphan (hoặc PG không có candidate).
- `RECONSTRUCTING`: có candidate vừa re-arm, chưa settle.
- `SUSPECT`: candidate còn tồn tại qua ≥2 kỳ liên tiếp hoặc stalled cap (D1) — **đây mới là "durable health trung thực"**: `redis:true` + `db:true` mà queue rỗng mồ côi → không còn `ok` mù.
- HTTP: giữ 200 ở OK/RECONSTRUCTING; SUSPECT → body DEGRADED, status = decision **D2** (đề xuất vẫn 200 + field, để monitor alert, tránh LB đá node khi reconstruct đang chạy — LB flap risk).
- Khi field tồn tại: FLIP p8-02b MM-05c (key-set assert + `/HEALTHY|DEGRADED/ characterization` → DEGRADED sau wipe) và thêm `queueIntegrity` vào `runtime.test.ts` W38-A6 health keys.

## 7. Checklist implement (platform lane — Claude Code)

1. `runtime.ts`: `sweepQueueIntegrity(limit?)` — tx READ (predicate §2 + FOR UPDATE SKIP LOCKED trên outbox), Redis xác nhận ngoài tx (getJob không thuộc PG tx), re-arm tx riêng per-row; return số re-armed.
2. `server.ts`: nối recoveryTimer (§4) + config knobs + `ctx.queueIntegrity` cache + /health field (§6).
3. Audit event `queue.integrity_stalled` khi chạm cap (severity warning, tenant-scoped hoặc platform-global như deadline-sweep W48-C1 precedent).
4. KHÔNG đổi dispatcher.ts/lifecycle.ts/migrations (thiết kế A không cần).
5. Cập nhật docs 04 (OPS-01 outbox), 12 (OPS-07 health), 17 (runbook: quy trình Redis-loss không còn "gọi admin sweep" làm bước 1).

## 8. Acceptance plan (DB window — Tester) — SUITE ĐÃ CHUẨN BỊ SẴN (cycle 78)

- **Suite live on-disk:** `tests/integration/p8-02c-mm05-rearm.integration.test.ts` (Qwen-2, 5 test, compile offline xanh: `5 skipped` exit 0 @03:5x). Pins docs/38 acceptance đúng §7 surface: rearm-0 meta (surface landed), rearm-1 E2E wipe→re-arm→republish SAME jobId→SUCCEEDED 0 TIMED_OUT, rearm-2 false-positive (job alive ⇒ 0 re-arm), rearm-3 terminal fence (CANCELLED op ⇒ không revive — parity RUN-07), rearm-4 /health `queueIntegrity{state,lastSweepAt}` (chốt MM-05c).
- **Triple gate:** `DU_LIVE_INFRA=1` (file) + `DU_MM05_REARM=1` (test-level — coordinator bật khi Qwen-1 declare done) + **rebuild dist** (`cd services/orchestrator && npm run build` — suite import `@du/orchestrator` = dist/server.js, dist cũ serve runtime cũ).
- **Prereq hạ tầng (học từ vòng 5-6 fail môi trường):** infra up 2/2 healthy TRƯỚC DB claim — `docker compose -f infra/docker-compose.yml up -d` (docs/29 A6fb7 bước 0).
- Khi rearm-1/4 xanh: FLIP nốt p8-02b MM-05c key-set (`server.ts` /health thêm `queueIntegrity` — docs/38 §6) trong cùng lượt; regression guard-order (vòng 6b) chạy cùng suite list.
- Literal kỳ vọng per docs/35 §1.4 (0 skipped/0 failed/exit 0 ×3).

## 9. Điều kiện nghiệm thu MM-05 tự chốt (tóm tắt)

MM-05 đóng khi: (a) sweepQueueIntegrity xanh live drill MM-05d; (b) /health phát queue-integrity trung thực (MM-05c flip xanh); (c) deadline sweep chỉ còn là escape hatch (runbook docs/17 cập nhật); (d) offline probe/1 FLIPPED thành pin "reconstructed" — file test sẽ nêu rõ điểm flip.

---

*Created 2026-09-25 (TURN 3-B). Probe offline: `orchestrator/services/orchestrator/tests/mm05-queue-integrity-offline.functional.test.ts` — `4 passed, 4 total` ExitCode 0 (03:25, zero DB/Redis). Ledger: docs/29 vòng 5-6, docs/35 §6 addendum, qwen2.md §35.*
