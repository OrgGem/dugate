# Receipt - CR10-02-D1: nhan tinh `usage dispatch cycle failed` vao SAFE_LOG_MESSAGES

| Truong | Gia tri |
|---|---|
| Task ID | CR10-02-D1 |
| Ngay | 2026-10-10 |
| Repo scope | du-rework |
| Canonical plan | `coordination/tasks/CODE-REVIEW-FOLLOWUP-2026-10-10.md` muc 2 (CR10-02) + receipt `coordination/reports/receipt-cr10-02-usage-dispatcher-2026-10-10.md` muc 5 Delta 1 |
| Dispatch spec | `coordination/dispatch-specs/2026-10-10-CR10-02D1-safe-log-messages.md` |
| Dispatch proof | `coordination/DISPATCH-LIVE-2026-10-10.md:20` (CR10-02-D1 -> Qwen-C, `term_c89675a0-351a-47cc-8c4d-21fb29d5d41a`, RUNNING); packet dong thoi duoc giao truc tiep cho lane nay trong phien |
| Lease | `orchestrator/packages/observability/src/log-events.ts`; `orchestrator/packages/observability/tests/payload-privacy.test.ts`; `orchestrator/packages/observability/dist/**` (build artifact); receipt nay |
| Owner lane | Qwen (implement) |
| Trang thai | **IMPLEMENTED + offline-verified [PASS] - CHUA ACCEPTED** (can independent verifier doc lap; lane KHONG tu accept) |
| Offline | Co - khong mo cua so DB/Redis/S3 nao trong toan bo cycle |
| Git | Khong `git add`, khong commit, khong push; khong co gi staged |

---

## 1. Van de (chung cu truoc khi sua)

CR10-02 da land trong working tree (chua commit) them containment tai
`orchestrator/services/connector/src/usage-dispatcher.ts:167`:

```ts
logger.error('usage dispatch cycle failed', { error: safeErrorForLog(error) });
```

`metadataLogRecord` (`packages/observability/src/log-metadata.ts:44`) chi cho truong `message` di qua khi
chuoi nam trong `SAFE_LOG_MESSAGES` (`packages/observability/src/log-events.ts:2`). Nhan chua co trong
danh sach nen dong log ra sink mat nhan, dung nhu spec muc 1 va receipt CR10-02 muc 5 Delta 1 mo ta:

```json
{"subsystem":"usage-dispatcher","error":{"kind":"UNEXPECTED_ERROR","message":"Unexpected error; details redacted."},"level":"error","message":"[REDACTED]"}
```

Chung cu doc lap (do lane DSH cung cap, khong do lane nay tao): `coordination/reports/verify-cr10-02-INDEPENDENT-DSH-2026-10-10.md:58`
grep `usage dispatch cycle failed` trong `log-events.ts` -> **0 hit**.

---

## 2. Thay doi (chi trong lease)

### 2.1 `orchestrator/packages/observability/src/log-events.ts` (+1 / -0)

Them DUNG MOT nhan tinh vao `SAFE_LOG_MESSAGES` (Set<string>), khong wildcard/prefix/regex, khong noi long co che:

```diff
@@ -56,6 +56,7 @@ export const SAFE_LOG_MESSAGES = new Set<string>([
   "unhandled listener error",
   "unhandled request error",
   "unknown migration command",
+  "usage dispatch cycle failed",
   "worker heartbeat failed",
   "workspace-reference query uncertain; treating dir as referenced"
 ]);
```

Vi tri dat nhan nam trong khoi da sap xep san cua Set (sau `unknown migration command`, truoc `worker heartbeat failed`);
quote kep theo dung khoi lan can trong file (file von da tron single/double quote; package lint = `tsc --noEmit`, khong ESLint).

### 2.2 `orchestrator/packages/observability/tests/payload-privacy.test.ts` (+31 / -1)

Them 3 test (dong 52-79), theo dung pattern test hien co (import `SAFE_LOG_MESSAGES` tu `../src/log-events`,
`safeErrorForLog` tu `../src/redaction`):

1. `CR10-02-D1: the usage dispatch cycle failure label is allowlisted verbatim` - positive control o tang projection:
   Set la `Set` that, `has('usage dispatch cycle failed') === true`, va `metadataLogRecord` giu nguyen nhan
   (kem `subsystem`, `error.kind`).
2. `CR10-02-D1: the connector log line keeps its label end to end` - positive control qua `createLogger` (dung shape
   dong log cua usage-dispatcher:167): `record.message === 'usage dispatch cycle failed'` va `!== REDACTED`.
3. `CR10-02-D1: allowlisting is exact - near-miss and prefix messages stay redacted` - negative control: 5 message
   gan dung/prefix/case/whitespace van `[REDACTED]` -> chung minh khop CHINH XAC, khong wildcard/prefix.

### 2.3 `orchestrator/packages/observability/dist/**` (build artifact, gitignore)

`@du/observability` resolve ve `dist/index.js`, KHONG phai `src/` - da do lai doc lap (muc 4.5). Vi vay da rebuild:
`npm run build` (`tsc -p tsconfig.json`), Exit Code: 0.

---

## 3. Test: RED truoc, GREEN sau

| # | Test | RED (truoc khi them label) | GREEN (sau khi them label) |
|---|---|---|---|
| 1 | label allowlisted verbatim | FAIL - `Expected: true, Received: false` (dung ly do: nhan chua co trong Set) | PASS |
| 2 | connector log line giu nhan end to end | FAIL - `Expected: "usage dispatch cycle failed", Received: "[REDACTED]"` | PASS |
| 3 | near-miss/prefix van redacted | PASS (negative control dung ngay tu dau) | PASS |
| 4 | 44 test hien co cua suite observability | PASS | PASS |

RED la do DUNG nguyen nhan (nhan thieu), khong phai loi compile/test sai: test import `SAFE_LOG_MESSAGES` tu
`src/log-events` (co san), va failure message chi ro `false` / `[REDACTED]`.

---

## 4. Bang chung chay (literal + exit code)

Tat ca lenh chay trong `orchestrator/packages/observability` (tru 4.5/4.6/4.7 ghi ro thu muc khac).
Exit code lay tu chinh tool runner (khong dung `%ERRORLEVEL%` cua cmd.exe vi gia tri do bi stale).

### 4.1 Baseline (truoc khi viet test)

```
$ npx jest --runInBand --testTimeout=20000
Test Suites: 3 passed, 3 total
Tests:       44 passed, 44 total
Exit Code: 0
```

### 4.2 RED (da them test, CHUA them label)

```
$ npx jest --runInBand --testTimeout=20000
  FAIL  tests/payload-privacy.test.ts
  ● CR10-02-D1: the usage dispatch cycle failure label is allowlisted verbatim
    expect(received).toBe(expected) // Object.is equality
    Expected: true
    Received: false
    > 54 |     expect(SAFE_LOG_MESSAGES.has('usage dispatch cycle failed')).toBe(true);

  ● CR10-02-D1: the connector log line keeps its label end to end
    expect(received).toBe(expected) // Object.is equality
    Expected: "usage dispatch cycle failed"
    Received: "[REDACTED]"
    > 68 |     expect(record.message).toBe('usage dispatch cycle failed');

Test Suites: 1 failed, 2 passed, 3 total
Tests:       2 failed, 45 passed, 47 total
Exit Code: 1
```

### 4.3 GREEN x3 lien tiep (sau khi them label)

```
$ npx jest --runInBand --testTimeout=20000
Test Suites: 3 passed, 3 total
Tests:       47 passed, 47 total
Time:        1.467 s
Exit Code: 0

$ npx jest --runInBand --testTimeout=20000
Tests:       47 passed, 47 total
Time:        1.395 s
Exit Code: 0

$ npx jest --runInBand --testTimeout=20000
Tests:       47 passed, 47 total
Time:        1.379 s
Exit Code: 0
```

### 4.4 Lint / typecheck package

```
$ npx tsc --noEmit -p tsconfig.json
(khong co output)
Exit Code: 0
```

### 4.5 Resolution cua connector (xac nhan ghi chu build cua spec la load-bearing)

Chay trong `orchestrator/services/connector`:

```
$ node -e "console.log(require.resolve('@du/observability'))"
D:\Git\dugate\du-rework\orchestrator\packages\observability\dist\index.js
Exit Code: 0
```

### 4.6 dist da rebuild (hash + grep nhan)

`dist/` bi gitignore (`.gitignore:2: dist/`), nen dung hash file + findstr nhu spec muc 5 cho phep:

```
$ certutil -hashfile dist\log-events.js SHA256     # TRUOC rebuild
0a13e202302252bb87094b444eebf82d698d5e67cc4eaae6fd7ed880898e0e89

$ npm run build                                     # tsc -p tsconfig.json
Exit Code: 0

$ certutil -hashfile dist\log-events.js SHA256     # SAU rebuild
bfb78f891f05c4613b800fdfb08b4e3164aabfdf48e66161b41fddad96b71e42

$ findstr /c:"usage dispatch cycle failed" dist\log-events.js
    "usage dispatch cycle failed",
Exit Code: 0

$ git status --porcelain -- orchestrator/packages/observability/dist
(rong - ignored, khong lam ban tracked tree)
```

### 4.7 End-to-end tang connector (khong con [REDACTED])

(a) Phat log qua artifact ma connector that su resolve (chay trong `orchestrator/services/connector`):

```
$ node -e "const o=require('@du/observability');const l=o.createLogger({service:'connector',baseFields:{subsystem:'usage-dispatcher'}});l.error('usage dispatch cycle failed',{error:o.safeErrorForLog(new Error('database unavailable'))});"
{"subsystem":"usage-dispatcher","error":{"kind":"UNEXPECTED_ERROR","message":"Unexpected error; details redacted."},"timestamp":"2026-10-10T07:06:10.582Z","level":"error","service":"connector","version":"unknown","environment":"dev","correlationId":"0c05240a-38e5-4029-bf58-f639869e6f9a","operationId":null,"taskId":null,"invocationId":null,"message":"usage dispatch cycle failed"}
Exit Code: 0
```

(b) Chay lai suite CR10-02 (`orchestrator/services/connector`) - chinh dispatcher that in ra dong log mang nhan:

```
$ npx jest --runInBand --testTimeout=20000 --runTestsByPath tests/cr10-02-usage-dispatcher-rejection.test.ts
10 dong log duoc in ra (dang rut gon, bo timestamp/correlationId), KHONG con [REDACTED]:
{"subsystem":"usage-dispatcher","error":{"kind":"UNEXPECTED_ERROR","message":"Unexpected error; details redacted."},"level":"error","service":"connector",...,"message":"usage dispatch cycle failed"}
Va mot dong DUNG NGUYEN VAN tu output:
{"subsystem":"usage-dispatcher","error":{"kind":"UNEXPECTED_ERROR","message":"Unexpected error; details redacted."},"timestamp":"2026-10-10T07:06:15.732Z","level":"error","service":"connector","version":"unknown","environment":"test","correlationId":"c6576ed2-12ef-4b08-9949-293f834df3b8","operationId":null,"taskId":null,"invocationId":null,"message":"usage dispatch cycle failed"}
 PASS  tests/cr10-02-usage-dispatcher-rejection.test.ts
  √ CR10-02: a claimBatch rejection at the scheduler boundary stays contained and the cadence continues (137 ms)
  √ CR10-02: a claimBatch rejection is contained for a direct dispatch cycle (2 ms)
  √ CR10-02: markDelivered and defer rejections are contained and the event is not marked delivered (2 ms)
  √ CR10-02: a defer rejection is contained and the event stays queued for retry (3 ms)
  √ CR10-02: drain stops the timer even when every poll fails (136 ms)
Tests:       5 passed, 5 total
Exit Code: 0
```

(c) Regression offline toan connector (`jest.unit.config.cjs` - da loai `black-box-durable`/`durable-integration`,
va loai case `live usage_events projection`):

```
$ npx jest --config jest.unit.config.cjs --runInBand --forceExit
Test Suites: 37 passed, 37 total
Tests:       1 skipped, 453 passed, 454 total
Exit Code: 0
```

---

## 5. Acceptance (doi chieu spec muc 5)

- [x] `usage dispatch cycle failed` co trong `SAFE_LOG_MESSAGES` (diff muc 2.1; grep dist muc 4.6).
- [x] Positive control: `metadataLogRecord({ message: 'usage dispatch cycle failed', ... })` giu nguyen nhan (test 1, 2).
- [x] Negative control xanh: message dong/gan dung van REDACTED (test 3); suite privacy hien co khong regression (47/47).
- [x] Khong them wildcard/prefix/regex; van la `Set<string>` cac nhan tinh (+1 dong literal).
- [x] `packages/observability` build lai; dist chua nhan moi (hash doi + findstr).
- [x] End-to-end connector: suite CR10-02 chay lai, 5/5, in ra dong log giu nhan, Exit Code: 0 (muc 4.7).
- [x] Offline: khong mo cua so DB/Redis/S3 nao.
- [x] Khong commit, khong push, khong git add; khong sua ngoai lease (muc 6).
- [x] Receipt ghi file nao doi, literal + exit code, va xac nhan dist da rebuild (hash).
- [ ] Independent verifier doc lap moi tinh ACCEPTED - **chua lam, thuoc coordinator/verifier**.

---

## 6. Lease / git (bang chung khong vuot lease)

```
$ git status --porcelain -- orchestrator/packages/observability
 M du-rework/orchestrator/packages/observability/src/log-events.ts
 M du-rework/orchestrator/packages/observability/tests/payload-privacy.test.ts

$ git diff --numstat -- orchestrator/packages/observability
1       0       du-rework/orchestrator/packages/observability/src/log-events.ts
31      1       du-rework/orchestrator/packages/observability/tests/payload-privacy.test.ts

$ git diff --cached --numstat -- orchestrator/packages/observability
(rong - khong co gi staged)
```

Read-only duoc ton trong: `orchestrator/services/connector/**` KHONG bi sua. `git diff --numstat` cho connector van la
`22  1  .../src/usage-dispatcher.ts` - dung bang thay doi CR10-02 co san tu truoc (receipt CR10-02), khong phai cua lane nay.
Nhan `usage dispatch cycle failed` tai `usage-dispatcher.ts:167` duoc lay lam INPUT, khong bi doi.

---

## 7. DELTA / quan sat

**DELTA-1 (test, khong phai product).** Lan chay GREEN dau tien cua toi do 1 test: assertion dau tien dung `toEqual`
qua hep - bo sot `level`/`service` (ca hai la IDENTIFIER hop le nen van di qua projection). Sua test thanh `toMatchObject`
la DUNG (khong phai noi long product). Khong co dong product nao bi doi vi ly do nay.

**DELTA-2 (pham vi cua "end-to-end").** Chung cu "dist thieu nhan truoc rebuild" khong duoc chay lai bang cach revert src
roi build lai (se tao churn/tranh cham vao trang thai da xac nhan). Chung cu "truoc" gom: hash dist truoc rebuild (muc 4.6),
grep 0-hit doc lap cua DSH (`verify-cr10-02-INDEPENDENT-DSH-2026-10-10.md:58`), va spec muc 1. Chung cu "sau" la truc tiep
(muc 4.6 + 4.7).

**DELTA-3 (ngoai lease, chi ghi nhan).** Co mot ban vendor rieng: `businesses/document-core/template/vendor/observability/src/log-events.ts`
voi `SAFE_LOG_MESSAGES` cua no, KHONG chua nhan nay (va cung khong co tham chieu `usage-dispatcher`). Khong sua (ngoai lease);
neu ban vendor do duoc dung cho emitter nao do thi can packet rieng.

**DELTA-4 (dist khong track).** `dist/` bi `.gitignore:2` nen khong co `git status` cho dist; da dung sha256 + findstr.
Luu y cho cutover: dist la artifact build cuc bo - moi truong build/deploy phai chay lai `npm run build` cua `@du/observability`
de nhan nay thuc su toi runtime, khong chi dua vao working tree.

---

## 8. Trang thai 4 muc

1. **Implemented**: co - 1 dong label trong `log-events.ts` + 3 test trong `payload-privacy.test.ts`.
2. **Offline-verified**: co - RED 2 fail/45 pass (exit 1) -> GREEN 47/47 x3 (exit 0), `tsc --noEmit` exit 0,
   connector offline unit 453 pass (exit 0), E2E connector in ra nhan dung.
3. **Accepted**: KHONG - can independent verifier doc lap voi implementer (lane khong tu accept).
4. **Merged/deployed**: KHONG - chua commit/push; dist la artifact cuc bo (xem DELTA-4).

**Rollout note:** khong co thay doi hanh vi ngoai viec mot nhan tinh moi duoc phep di qua projection. Khong mo them
duong cho du lieu tuy y: chi chuoi literal `usage dispatch cycle failed` duoc mien redact.

---

## 9. RESUME POINT

- Da xong: label + test + rebuild dist + bang chung literal + receipt nay.
- Con lai (khong thuoc lane nay): independent verifier doc lap chay lai (i) suite observability, (ii) grep/findstr nhan trong
  `dist/log-events.js`, (iii) suite CR10-02 + doc dong log in ra, (iv) doi chieu hash dist; sau do coordinator tick gate.
- Khong co pending nao khac trong lease. Khong commit/push.
