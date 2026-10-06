# F-PP1 closure re-verify (cc_2)

**Packet:** FPP1-closure-reverify · **Lane:** cc_2 · **Dispatch:** 2026-10-04T15:32+07:00 (spec `coordination/dispatch-specs/2026-10-04-1532-FPP1-closure-reverify.md`).
**Mode:** READ-ONLY; không sửa gì; không commit. File ghi: receipt này.
**Nguồn finding:** `profile-phase1-verify-2026-10-04.md` §3 (F-PP1 — mapping priority ngược chiều legacy).

## 0. TL;DR — VERDICT: `VERIFIED` — **F-PP1 ĐÓNG**

Cả 3 điểm sửa đúng và đủ: weights `{LOW:20, MEDIUM:10, HIGH:1}` + comment lower-first/parity; test pin mới + parity + ordering; openapi description đúng chiều. Không còn nguồn đảo chiều trong phạm vi; suite 27/27, `tsc` 0, openapi 26/45/10/0. **Consumer đầu tiên đã xuất hiện** (`modules/profiles/policy.ts:82-85`) và dùng đúng chiều — ghi nhận, không cần hành động cho closure.

## 1. Ba điểm sửa (literal)

1. **Contract** — `packages/contracts/src/profile-policy.ts:103-112`:
   - comment mới: *"BullMQ priority is INVERTED: a LOWER number runs FIRST. Legacy `lib/pipelines/submit.ts:26-32` pins HIGH=1, MEDIUM=10, LOW=20 … not a 'weight' where bigger wins."* (`:107-109`);
   - giá trị: `export const PROFILE_JOB_PRIORITY_WEIGHTS = { LOW: 20, MEDIUM: 10, HIGH: 1 };` (`:111-112`) — **khớp legacy** `lib/pipelines/submit.ts:26-32`.
2. **Test** — `packages/contracts/tests/profile-policy.test.ts`:
   - pin mới `expect(PROFILE_JOB_PRIORITY_WEIGHTS).toEqual({ LOW: 20, MEDIUM: 10, HIGH: 1 })` (`:57`);
   - parity với hằng legacy: `const LEGACY_BULLMQ = { HIGH: 1, MEDIUM: 10, LOW: 20 }` (`:61`) + 3 assert equality (`:62-64`) + hướng đơn điệu `HIGH < MEDIUM < LOW` (`:68-69`).
3. **OpenAPI** — `docs/21-openapi.json:741`: description mới *"BullMQ priority: LOW 20 / MEDIUM 10 / HIGH 1 - parity legacy HIGH=1 (lib/pipelines/submit.ts:26-32). BullMQ runs the LOWER number first, so HIGH must be 1, not 20."*

## 2. Gates (literal)

```
cwd: du-rework/packages/contracts (NODE_ENV=test)
> pnpm exec jest --runInBand tests/profile-policy.test.ts
tests=27 passed=27 failed=0        (per-suite: profile-policy.test.ts :: 27)   JEST_EXIT=0
  (count vẫn 27 — parity assert nằm trong case priority sẵn có, không thêm case mới; "có thể 28" của dispatch không xảy ra)
> pnpm exec tsc --noEmit -p tsconfig.json
CONTRACTS_TSC_EXIT=0

> node <check> docs/21-openapi.json
{ "version": "1.3.0", "schemas": 26, "paths": 45, "xAbsent": 10, "refs": 18, "unresolved": 0 }
```

## 3. Không còn nguồn đảo chiều (grep scope: contracts/** + openapi + orchestrator src/**)

- `PROFILE_JOB_PRIORITY_WEIGHTS`: chỉ còn định nghĩa đúng (`profile-policy.ts:111-112`) + test pin/parity đúng chiều (`tests:57,61-64`) + consumer (mục 4). Không còn literal `LOW:1/HIGH:20` hay `{ LOW: 1, MEDIUM: 10, HIGH: 20 }` trong phạm vi kiểm.
- Orchestrator src: grep `LOW: 1|HIGH: 20|21 -` = **0** — không có bảng đảo chiều và cũng không có kiểu "bù trừ" (`21 - weight`) nào.
- Các hit còn lại của chuỗi `1/10/20` nằm ở **receipt/dispatch/tasks lịch sử** (không phải nguồn thực thi) — đúng như dự kiến.

## 4. Consumer đầu tiên — ghi nhận (không thuộc packet này)

`services/orchestrator/src/modules/profiles/policy.ts:82-85` (mtime **15:26:37**, file mới của lane phase-2: `profiles.ts` M + `policy.ts`/`publish.ts`/`file-url-auth.ts` untracked):

```ts
/** The BullMQ `priority` option for a profile priority. Lower runs first. */
export function bullMqPriorityFor(priority: ProfileJobPriority): number {
  return PROFILE_JOB_PRIORITY_WEIGHTS[priority];
}
```

⇒ First consumer map **trực tiếp**, comment đúng hướng, không đảo lại ⇒ thừa hưởng parity đúng; F-PP1 nhờ đó được đóng mà không để lại rủi ro wire cho T-SUB-03. Recommendation: verify của lane phase-2 tự phủ consumer này (ngoài phạm vi closure).

## 5. Giới hạn

- Không chạy full contracts suite / orchestrator suite (ngoài phạm vi closure; suite liên quan đã xanh).
- Lịch sử receipt `profile-phase1-verify` giữ nguyên dòng claim cũ đã bị đính chính — closure này là nguồn đối chiếu.

**Verdict: `VERIFIED` — đóng finding F-PP1** (3/3 điểm sửa đúng, không còn nguồn đảo chiều, gates xanh).

*Không tick, không commit.*
