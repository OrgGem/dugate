# Lane C - OPU-OPS-3 timeline + correlationId, OPU-OPS-4 time filter / id search / bulk cancel (2026-10-08)

Task: dispatch packet `coordination/dispatch-specs/2026-10-08-portal-wave1.md` section Lane C.
Trang thai: DONE - harness 15/15 exit 0, typecheck exit 0, regression Lane B exit 0. Khong commit / git add / push, khong sua docs/21-openapi.json, khong doc .env.live, khong tick gate, offline (khong chay PostgreSQL/Redis).

## 1. Pham vi thuc te

- `apps/admin-web/src/features/operations/operations-screen.tsx` - sua (+140 / -5, `git diff --stat`).
- `services/orchestrator/tests/operations-timeline-filters-offline.cjs` - tao moi (harness fail-first, 15 assertion).
- `services/orchestrator/tests/operations-download-live-offline.cjs` - **sua lai** (file da o Lane B): cot `Total elapsed` chuyen tu index co dinh sang tra cuu theo header, vi Lane C chen cot `Select` lam lech index. Khong doi nghia assertion.

Khong dung: `services/orchestrator/src/**`, `packages/**`, `docs/**`, `docs/21-openapi.json`, task plan file, man hinh khac cua admin-web, `.env.live`.

## 2. RED truoc khi sua (fail-first, exit 1)

**Ghi chu trung thuc quan trong:** khong co mot lan chay RED "truoc khi viet product" sach se, vi harness duoc viet trung voi lan nay va no co 2 loi cua chinh no. Lan RED dau tien (sau khi product da viet, truoc khi sua harness) - literal:

```
cd D:/Git/dugate/du-rework/orchestrator/services/orchestrator
node tests/operations-timeline-filters-offline.cjs
```

```
ok   OPS-2: a 1s tick interval exists while a non-terminal op is shown
FAIL OPS-2: unknown start renders Unknown, never a fabricated 0
elapsed cell for unknown start was "In progress"
FAIL OPS-2: clock ticks without a manual refresh (the interval drives the elapsed text)
expected 0.0 s before tick, saw "In progress"
ok   OPS-1: artifact with downloadUrl renders a real download link
ok   OPS-1: artifact without downloadUrl renders unavailable text, never a broken anchor
ok   OPS-2: no interval starts when every op is terminal
FAIL OPS-4: toolbar renders an id search input
no id-search input in the toolbar
FAIL OPS-4: toolbar renders from/to date inputs
no From input, labels=[]
FAIL OPS-4: typing an id substring re-queries the list with id
no id-search input to type into
FAIL OPS-4: a from/to window filters the loaded page
from/to inputs missing (0 inputs)
FAIL OPS-4: rows expose selection checkboxes and a bulk cancel control
no selection checkbox, saw 0
FAIL OPS-4: bulk cancel sends one cancel per selected non-terminal row
no checkbox bound to the running row
FAIL OPS-3: detail renders the correlationId from the payload
row id button not clickable
FAIL OPS-3: detail renders a timeline with task/state/attempt/errorCode
no operations timeline element
FAIL OPS-3: missing correlationId renders Unavailable (never blank)
row id button not clickable (no-correlation scenario)
FAILED 11 assertion(s)
Exit Code: 1
```

**Phan tich nguyen nhan RED (khong duoc bo qua):** 9/11 FAIL la **loi harness**, khong phai loi product:

1. `let t = await h.render()` - `render()` tra ve `{ tree }`, nen `t` la wrapper, khong phai cay. `collect(t, ...)` tim 0 nut -> "no id-search input", "labels=[]", "row id button not clickable". Sua: `let t = (await h.render()).tree`.
2. `cells[5]` - cot elapsed nam o index 5 truoc khi Lane C chen cot `Select`; sau chen la index 6. Hai assertion OPS-2 bi do sai cot ("saw In progress"). Sua: `columnIndex(tree, 'Total elapsed')` tra cuu theo header, khong dung index co dinh.
3. Predicate tim nut bulk cancel dung `n.type === 'button'`, nhung nut do la component `<Button>` (mock co `.name === 'Button'`) -> khong khop. Sua predicate.
4. Sandbox vm thieu `crypto` ma `cancelSelected()` goi `crypto.randomUUID()` -> ReferenceError. Them vao sandbox.
5. Assertion OPS-3 "missing correlationId" kiem tra ca cay, trong khi placeholder cua timeline rong cung in chu "Unavailable" -> co the xanh sai ly. Sua: scope vao khoi `aria-label="Operation correlation"`.

Sau khi sua harness, product khong can sua them gi de xanh (xem muc 4). Day la bang chung that assertion khong bi "weaken": moi sua deu giu nguyen dieu kien kiem tra, chi sua cach dinh vi tri cot / pham vi tim kiem.

## 3. Sua gi (chi operations-screen.tsx)

1. **OPU-OPS-4 - tim theo id:** state `idFilter`; `load()` gui `...(idFilter.trim() === '' ? {} : { id: idFilter.trim() })` (route da allow-list param `id` = `OPERATIONS_LIST_QUERY_PARAMS` trong `packages/contracts/src/public-api.ts:63`, nen khong can sua backend). Input `aria-label="Search by operation id"`.
2. **OPU-OPS-4 - loc theo khoang thoi gian:** state `fromDate`/`toDate` + hai input `type="date"` (`aria-label="From date (UTC)"` / `"To date (UTC)"`). Loc **chi tren trang da load** (`visibleItems = pane.data.items.filter(inWindow)`), gioi han UTC inclusive theo `createdAt`; ghi chu tren UI: "Time window applies to the loaded page (UTC dates)." Khong goi lai server.
3. **OPU-OPS-4 - chon nhieu + cancel lo:** state `selected` (Set), cot `Select` voi checkbox `aria-label={`select ${op.id}`}` (disabled khi op terminal), nut `Cancel selected` (disabled khi `selected.size === 0` hoac role `viewer`). `cancelSelected()` goi `operationAction(id, 'cancel', key)` tung dong cho op non-terminal, dung o dau tien that bai, xoa selection, bao notice so luong.
4. **OPU-OPS-3 - correlationId:** helper `correlationFromRaw(detail.raw)` doc tu node `operation` hoac flat; render trong khoi `aria-label="Operation correlation"` voi `<code>`, fallback `Unavailable` khi thieu (khong bao gio de trong).
5. **OPU-OPS-3 - timeline:** `<ol aria-label="Operations timeline">` liet ke `detail.tasks` theo thu tu tra ve: `{task.taskKey || task.kind} · {task.state} · attempt {task.attempt}/{task.maxAttempts} · {task.errorCode ?? 'Unavailable'}`; tasks rong thi `<li>Unavailable</li>`.

**Loi product bat duoc boi typecheck (khong phai boi harness):** `detail.tasks` la optional -> `TS18048: 'detail.tasks' is possibly 'undefined'` tai dong 466/469. Sua bang `const detailTasks = detail?.tasks ?? [];` (cung kieu voi `correlationId`).

## 4. PASS sau khi sua (exit 0)

```
cd D:/Git/dugate/du-rework/orchestrator/services/orchestrator
node tests/operations-timeline-filters-offline.cjs
```

```
ok   OPS-2: a 1s tick interval exists while a non-terminal op is shown
ok   OPS-2: unknown start renders Unknown, never a fabricated 0
ok   OPS-2: clock ticks without a manual refresh (the interval drives the elapsed text)
ok   OPS-1: artifact with downloadUrl renders a real download link
ok   OPS-1: artifact without downloadUrl renders unavailable text, never a broken anchor
ok   OPS-2: no interval starts when every op is terminal
ok   OPS-4: toolbar renders an id search input
ok   OPS-4: toolbar renders from/to date inputs
ok   OPS-4: typing an id substring re-queries the list with id
ok   OPS-4: a from/to window filters the loaded page
ok   OPS-4: rows expose selection checkboxes and a bulk cancel control
ok   OPS-4: bulk cancel sends one cancel per selected non-terminal row
ok   OPS-3: detail renders the correlationId from the payload
ok   OPS-3: detail renders a timeline with task/state/attempt/errorCode
ok   OPS-3: missing correlationId renders Unavailable (never blank)
PASS operations-timeline-filters-offline.cjs - 15 assertions (OPS-1 x2, OPS-2 x4, OPS-4 x6, OPS-3 x3)
Exit Code: 0
```

Typecheck (yeu cau cua packet):

```
cd D:/Git/dugate/du-rework/orchestrator
pnpm --filter @du/admin-web typecheck
```

```
> @du/admin-web@0.0.0 typecheck D:/Git/dugate/du-rework/orchestrator/apps/admin-web
> tsc --noEmit -p tsconfig.json
Exit Code: 0
```

Regression (harness Lane B, file da nop truoc do):

```
cd D:/Git/dugate/du-rework/orchestrator/services/orchestrator
node tests/operations-download-live-offline.cjs
```

```
ok   OPS-2: a 1s tick interval exists while a non-terminal op is shown
ok   OPS-2: unknown start renders Unknown, never a fabricated 0
ok   OPS-2: clock ticks without a manual refresh (the interval drives the elapsed text)
ok   OPS-1: artifact with downloadUrl renders a real download link
ok   OPS-1: artifact without downloadUrl renders unavailable text, never a broken anchor
ok   OPS-2: no interval starts when every op is terminal
PASS operations-download-live-offline.cjs - 6 assertions (OPU-OPS-1 x2, OPU-OPS-2 x4)
Exit Code: 0
```

## 5. Mutation - fail-first tung assertion (moi mutation = bo dung 1 tinh nang product)

Moi lan: ap dung 1 mutation vao `operations-screen.tsx`, chay harness, ghi exit code + dong FAIL literal, roi **restore byte-exact** (so sanh noi dung file truoc/sau). Ket thuc: `FINAL RESTORE: PRISTINE` (file giong het lan dau).

| ID | Tinh nang bi bo | exit | Assertion bi do | So FAIL |
|---|---|---|---|---|
| M1 | param `id` trong query list | 1 | OPS-4: typing an id substring re-queries the list with id | 1 |
| M2 | input tim theo id | 1 | OPS-4: toolbar renders an id search input (+ typing) | 2 |
| M3a | input From | 1 | OPS-4: toolbar renders from/to date inputs (+ window) | 2 |
| M3b | input To | 1 | OPS-4: toolbar renders from/to date inputs (+ window) | 2 |
| M4 | loc theo khoang ngay | 1 | OPS-4: a from/to window filters the loaded page | 1 |
| M5 | checkbox chon dong | 1 | OPS-4: rows expose selection checkboxes and a bulk cancel control (+ bulk cancel) | 2 |
| M6 | nut Cancel selected | 1 | OPS-4: rows expose selection checkboxes and a bulk cancel control (+ bulk cancel) | 2 |
| M7 | correlationId | 1 | OPS-3: detail renders the correlationId from the payload | 1 |
| M8 | khoi timeline | 1 | OPS-3: detail renders a timeline with task/state/attempt/errorCode | 1 |
| M9 | fallback Unavailable | 1 | OPS-3: missing correlationId renders Unavailable (never blank) | 1 |

Literal vi du (M7 - bo correlationId):

```
FAIL OPS-3: detail renders the correlationId from the payload
correlationId not rendered in the correlation row
FAILED 1 assertion(s): OPS-3: detail renders the correlationId from the payload
Exit Code: 1
```

Literal vi du (M8 - bo timeline):

```
FAIL OPS-3: detail renders a timeline with task/state/attempt/errorCode
no operations timeline element
FAILED 1 assertion(s): OPS-3: detail renders a timeline with task/state/attempt/errorCode
Exit Code: 1
```

**Ghi chu trung thuc ve mutation:** M7 ban dau con lam do them assertion timeline, vi `t = next` chi chay sau khi assertion truoc xanh. Da tach: bind `t = next` **truoc** khi assert, de moi mutation doc lap. Sau sua, M7 chi do dung 1 assertion. Day la loi cua harness, khong phai loi product.

## 6. Ket luan trung thuc - phan con thieu

1. **Khong co bang chung live/browser.** Toan bo bang chung la harness offline (fake React + fake client). Chua chay that trong trinh duyet, chua kiem tra layout/overflow cua toolbar khi co 3 input moi.
2. **Khoang thoi gian chi loc trang da load** (gioi han `limit`), khong goi lai server. Route `GET /api/v1/operations` khong co param from/to nen khong the loc server-side ma khong sua backend (ngoai pham vi). Da ghi ro tren UI.
3. **correlationId chua duoc kiem chung that.** Doc tu `detail.raw` cua payload gia. Chua xac dinh BFF co tra ve `correlationId` that cho operation that khong - can kiem tra live.
4. **Timeline khong phai truc thoi gian su kien that.** Chi dung `detail.tasks` theo thu tu API tra ve, in task/state/attempt/errorCode. Khong co thong tin worker/outbox hop nhu mo ta trong task file ([AOPS-05] "task -> worker -> outbox -> lan thu"). De lam dung can payload su kien rieng.
5. **Khong co auto-refresh danh sach.** Elapsed nhay (OPS-2) nhung state khong tu doi khi job xong - `OPU-G2` la item cross-cutting rieng, khong lam o day.
6. **Bulk cancel khong co confirm()** (khac voi cancel don le co `window.confirm`), dung o dau tien that bai roi dung, notice chi bao so luong thanh cong, khong liet ke dong nao that bai. Chua co assertion cho duong loi nay.
7. **Selection khong luu khi phan trang / refresh** (state cuc bo, F5 la mat) - `OPU-G3` deep-link van chua lam.
8. **Chua co assertion cho:** role `viewer` bi khoa bulk cancel, cancel that bai giua lo, op `CANCEL_REQUESTED` trong bulk.
9. **Khong tick gate.** Khong commit, khong add, khong push.

## 7. Raw logs

`coordination/reports/raw/portal-ops-lane-c-2026-10-08/`

- `green-lane-c-harness.log` - harness Lane C xanh (15 assertion, exit 0)
- `regression-lane-b-harness.log` - harness Lane B xanh (6 assertion, exit 0)
- `typecheck-admin-web.log` - typecheck exit 0
- `mutation-matrix.log` - 10 mutation, exit code + dong FAIL literal tung lan
- `diffstat-screen.txt` - `git diff --stat` cua man hinh
