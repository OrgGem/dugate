# Lane B - OPU-OPS-1 download link + OPU-OPS-2 live elapsed (2026-10-08)

Task: dispatch packet `coordination/dispatch-specs/2026-10-08-portal-wave1.md` section Lane B.
Trạng thái: DONE - hai lệnh verify đều exit 0. Không commit / git add / push, không sửa docs/21-openapi.json, không đọc .env.live, không tick gate, offline (không chạy PostgreSQL/Redis).

## 1. Phạm vi thực tế

- `apps/admin-web/src/features/operations/operations-screen.tsx` - sửa (mục 3).
- `services/orchestrator/tests/operations-download-live-offline.cjs` - tạo mới (harness fail-first).
- `apps/admin-web/src/features/operations/state.ts` - KHONG sua: `parseOperationDetail` da parse `downloadUrl` (dong 57) va `elapsedMs` da tra `null` khi thieu diem bat dau.

Ghi chu trung thuc: packet ghi khong co hien thi elapsed, nhung man hinh DA co cot `Total elapsed` tinh tai moi render; van de that la khong tu nhay khi khong refresh (render chi chay khi co setState). Cot do duoc noi vao dong ho, khong viet lai.

## 2. RED truoc khi sua product (fail-first, exit 1)

```
cd D:/Git/dugate/du-rework/orchestrator/services/orchestrator
node tests/operations-download-live-offline.cjs
```

Literal (harness on dinh, tren code chua fix):

```
FAIL OPS-2: a 1s tick interval exists while a non-terminal op is shown
expected >=1 active interval, saw 0
ok   OPS-2: unknown start renders Unknown, never a fabricated 0
FAIL OPS-2: clock ticks without a manual refresh (the interval drives the elapsed text)
no interval registered while a non-terminal op is shown (saw 0)
FAIL OPS-1: artifact with downloadUrl renders a real download link
no anchor with href /api/v1/operations/11111111-1111-4111-8111-111111111111/download; saw []
FAIL OPS-1: artifact without downloadUrl renders unavailable text, never a broken anchor
expected exactly 1 anchor, saw []
0 !== 1
ok   OPS-2: no interval starts when every op is terminal
FAILED 4 assertion(s): OPS-2: a 1s tick interval exists while a non-terminal op is shown | OPS-2: clock ticks without a manual refresh (the interval drives the elapsed text) | OPS-1: artifact with downloadUrl renders a real download link | OPS-1: artifact without downloadUrl renders unavailable text, never a broken anchor
Exit Code: 1
```

Hai assertion xanh o RED tren la guard co san (unknown start = Unknown, khong bia 0.0 s; moi op terminal thi khong bat interval) - giu nguyen, khong sua de xanh.

## 3. Sua gi (chi operations-screen.tsx)

1. OPU-OPS-1 - bang Artifacts trong Detail: them cot `Download` (header) va o; co `downloadUrl` thi render `<a href={downloadUrl} download>` (khong tu tao URL, chi dung gia tri da parse); khong co thi `<span>` chu `Unavailable` voi class `text-xs text-[var(--text-sub)]` (cung style unavailable cac panel khac dung). Khong bao gio render anchor rong.
2. OPU-OPS-2 - dong ho live: them state `nowIso` + `setInterval(1000ms)` chi khi man hinh co it nhat 1 op non-terminal (`listHasLive`/`detailHasLive`), effect tra ve `clearInterval`; o elapsed trong bang va 2 dong elapsed o Detail doi sang `elapsedMs(op, nowIso)`. Op terminal dung `createdAt/completedAt` nen khong nhay; thieu diem bat dau van ra `Unknown`.

## 4. PASS sau khi sua (exit 0)

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

## 5. Mutation - chung minh assertion OPS-1 nang phan product

RED dau cua OPS-1 tung bi anh huong loi timing cua harness (muc 7), nen khong nhan do lam bang chung. Tao rieng: go moi o `Download` trong operations-screen.tsx, chay lai:

```
ok   OPS-2: a 1s tick interval exists while a non-terminal op is shown
ok   OPS-2: unknown start renders Unknown, never a fabricated 0
ok   OPS-2: clock ticks without a manual refresh (the interval drives the elapsed text)
FAIL OPS-1: artifact with downloadUrl renders a real download link
no anchor with href /api/v1/operations/11111111-1111-4111-8111-111111111111/download; saw []
FAIL OPS-1: artifact without downloadUrl renders unavailable text, never a broken anchor
expected exactly 1 anchor, saw []
0 !== 1
ok   OPS-2: no interval starts when every op is terminal
FAILED 2 assertion(s): OPS-1: artifact with downloadUrl renders a real download link | OPS-1: artifact without downloadUrl renders unavailable text, never a broken anchor
Exit Code: 1
```

Khoi phuc o `Download`, chay lai -> PASS 6 assertion, Exit Code 0 (dung output muc 4).

## 6. Typecheck

```
cd D:/Git/dugate/du-rework/orchestrator/apps/admin-web
pnpm --filter @du/admin-web typecheck
```

Output: chi 5 dong WARN `Unsupported engine: wanted node >=24.21.0 <25 (current v22.16.0)` + thong bao tsc cua pnpm script. Exit Code: 0 (tsc --noEmit khong loi).

## 7. FAIL section (trung thuc)

1. Ba lan chay RED dau bi loi HARNESS, khong phai loi product - da sua va khong dua vao bang chung:
   - `render()` splice `effects` truoc khi tien hanh render nen `load()` khong chay -> man hinh luon o LoadingState (khong co hang, khong co detail).
   - `check()` khong `await` fn async -> in ra ok sai va crash unhandled rejection.
   - sau khi click mo detail, phai `setImmediate` cho `openDetail` xong truoc khi render lai, khong thi detail chua ra va assertion OPS-1 do (khong tim thay anchor).
2. Mot assertion false-pass da dong: dung `clock += 5000` roi render thu cong khien elapsed doi du khi KHONG co interval. Day khong phai la tick. Da siets: bat buoc co interval 1000ms dang hoat dong truoc khi do timer, roi moi do van `5.0 s`.
3. RED hop le cho OPS-1 lay tu muc 5 (mutation), khong lay tu cac lan RED loi harness.
4. Khong chay test khac ngoai 2 lenh packet yeu cau; khong quan sat test do nao khac. WARN ve engine Node 22 toan repo la truoc co san, khong lien quan change nay.
5. `state.ts` khong sua, khong sua file nao ngoai lease; khong can sua file ngoai lease.

## 8. Checkpoint

- File da sua: 1 (operations-screen.tsx). File tao moi: 1 (operations-download-live-offline.cjs, 221 dong).
- 6/6 assertion xanh sau mutation restore; typecheck exit 0.
- Khong commit, khong git add, khong push; khong sua docs/21-openapi.json; khong doc .env.live; khong tick VERIFIED hay ACCEPTED; khong chay PostgreSQL/Redis.