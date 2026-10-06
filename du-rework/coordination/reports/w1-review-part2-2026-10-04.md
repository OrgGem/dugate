# W1 DESIGN REVIEW — Part 2 (VERDICT cho slice producer + T-PROF-03) — 2026-10-04

**Packet:** W1 REVIEW PART 2 (run `run_069ecd6957cd`, task `task_c5fe5231eebb`).
**Owner:** Claude Code — REVIEW-ONLY. READ-ONLY: khong sua code/test/docs, khong tick, khong commit.
**Evidence base:** P1 (`w1-review-part1-2026-10-04.md`, doc lap doc code) +
tester.md §P730-W2-B receipt 02 (19:20 +07) + `w1-receipt-audit-2026-10-04.md` (cc_1) +
qwen1.md §T-PROF-03 CLOSURE (19:2x) + plan-review-730 §2 + plan-refresh-736-740 §2.
**Slice duoc verdict:** producer (T-SUB-01/02/03: admission seam, no-secret snapshot DTO,
strict claim parse, sourceUrl gate, F-PP1) + T-PROF-03 decision layer (publish/rollback/CAS).
W1b (SDK consume) / W1c (acquisition) / live PG **chua implement — ngoai verdict**, xem §5.

---

## VERDICT: APPROVED-WITH-CONDITIONS

Slice producer + T-PROF-03 **dat o muc offline implemented+verified** voi 4 dieu kien
dong o §4. Khong phai CHANGES_REQUIRED vi khong co defect nao nam TRONG slice doi
rewrite product code; khong phai APPROVED tron vi P2 + 2 MEDIUM observations + phan
live con mo. Dieu kien (1) la hard gate truoc W1c; (2)(3) la scoped follow-up packets;
(4) la live acceptance rieng.

---

## 1. Co so verdict (tai sao slice dat)

- **Producer no-secret:** P1 verified tren code (builder strict DTO, `stringify(profile.policy)`
  0 match, guard co consumer that, sourceUrl gate dung vi tri, F-PP1 giu huong) +
  cc_1 audit 6/6 + 2/2 SUPPORTED + lease PASS + no-tick PASS.
- **W2-B independent offline proof cho producer:** 8/11 pass — sentinel that (bearer/header/query)
  absent tren submit SQL params, snapshot, task payload, outbox payload, claim response,
  stdout/stderr; strict unknown/malformed fail closed 422; priority F-PP1 dung huong;
  extension paths (fileUrls, artifact filenames, sourceUrl, query-string exclusion).
  3 fail **chinh la P2 finding** (test chung minh bug, khong phai regression) — xem §2.
- **T-PROF-03 decision layer:** 25/25, x3 runs exit 0, combined 51/51 + lint 0, publish.ts
  0 product diff (digest `AE76AC4BC2D6` khop HANDOFF), mutation probe 5/25 RED dung ly do +
  revert byte-identical. 9 invariants (CAS move, rollback semantics, FOR UPDATE order,
  pointer-only writes, no MAX fallback, null semantics, FK phan loai, upsert, tx reuse)
  co evidence.
- **Trung thuc bao cao:** ca 3 nguon (qwen1, tester, cc_1) tu khai gioi han (offline-only,
  mock-concurrency, khong re-run lan nhau). Khong phat hien fabrication.

## 2. Tra loi 4 cau hoi (per spec task)

### Q1 — P2 ref-tuple co doi DTO khong?

**Khong.** P2 (P730-W2-B-01) la **runtime claim-validation gap doc lap DTO W1**:
parser ap dung strict shape schema nhung khong compare ref tuple voi operation row,
claim mismatched ref + commit lease/state updates. Fix dung la **runtime comparison**
(so `tenantId/profileId/profileRevision` cua ref voi pinned operation identity,
mismatch => typed INVALID_SCHEMA fail TRUOC lease/state commit) — dung huong
P730-REF-BIND-FIX (`task_6d21a84909fd`, exclusive lease `runtime.ts`).

- MEDIUM-2 cua P1 (tenantId `string.min(1)` thay vi uuid) la **defense-in-depth, khong phai
  root cause**: gia tri ghi tu `ctx.tenantId` (cung nguon voi cot operation) nen nhat
  quan noi bo; siet `z.string().uuid()` khong chan duoc tuple lech neu writer ghi sai
  co chu dich. **Khuyen nghi: KHONG doi DTO luc nay** — doi DTO = re-freeze checkpoint (a)
  + rerun toan bo consumers bi anh huong, chi phi cao, loi ich thap so voi runtime check.
  Co the siet uuid trong mot DTO revision sau nhu mot hardening rieng, khong gan voi P2.
- Dieu kien: P2-FIX phai land + Tester rerun 3 negative cells + valid-ref/DD03 controls
  xanh **truoc khi W1c dung pointer** (hard gate, xem §4(1)).

### Q2 — `parameters.value: z.unknown()` (MEDIUM-1): khuyen nghi fix scope + test

Scope de xuat (packet rieng, khong trong slice nay vi ngoai chu PLAN04-01):

1. **Quyet dinh threat model** (coordinator + security owner): parameters co phai
   admin-trusted input khong?
2. **Test pin hanh vi da quyet** (file test moi, scoped):
   - Neu admin-trusted: test inject sentinel vao parameter value + assert snapshot
     mang dung gia tri (pin behavior, kem acceptance note "parameters la admin-trusted,
     khong scan") — tranh mo lai.
   - Neu khong trusted: predicate scan (tai dung `leaks()`-style) tren parameter values
     tai `buildProfilePolicySnapshot` + fail-closed/warn + test 2 chieu. Luu y false-positive
     risk tren free-form values — ly do toi khuyen nghi **quyet dinh truoc, code sau**.
3. Khong cham DTO shape (them scan la logic, khong doi contract) => khong trigger re-freeze.

**Khuyen nghi cua toi:** option admin-trusted + pin test + acceptance note, tru khi
security lane chi ra vector cu the (vd: parameter value do end-user khong phai admin
ghi duoc — neu co duong caller-supplied nao ghi thang vao parameters ma khong qua
AJV action schema hep thi phai chon scan).

### Q3 — DD-03 rows cu: live-only (dong y voi spec)

DD-03 offline DONE (2/2, exit 0): legacy plaintext-shaped row => 422, valid control => OK.
Phan con lai **chi lam duoc tren live DB**: count-only scan rows candidate + PG rollback
that, theo dung receipt Tester (khong JSON/IDs/secret, khong xoa/rewrite tu y).
Khong thuoc verdict slice nay; la dieu kien cua live acceptance.

### Q4 — W1b/W1c: xac nhan ngoai verdict

SDK grep `profilePolicy|fileUrlAuthConfig` = 0 match (P1); W2-B ghi nhan GAP SDK-CONSUME
(`DefaultTaskContext`/document-core chua consume, 1 `test.todo`) + GAP W1c (resolve/decrypt
chua implement). Verdict nay **chi cho slice producer+T-PROF-03** va khong suy ra dieu gi
ve consumer/acquisition/live.

## 3. Dieu kien dong (conditions to close)

| # | Dieu kien | Loai | Gate cho |
|---|---|---|---|
| (1) | **P2-FIX** (`task_6d21a84909fd`): runtime compare ref tuple vs operation row, fail truoc lease/state commit; Tester rerun 3 negative cells + valid-ref/DD03 controls xanh | **HARD** | W1c dung `credentialRef` (acquisition). SDK-CONSUME doc-only co the song song vi chua fetch credential |
| (2) | **MEDIUM-1 packet**: quyet threat model parameters + test pin hanh vi (§2-Q2) | Scoped follow-up | Live/full acceptance PLAN04-01; khong chan (1) hay W1b doc-only |
| (3) | **MEDIUM-2 (optional hardening)**: siet `tenantId: z.string().uuid()` trong DTO revision sau, neu muon | Optional, co re-freeze cost | Khong gan voi P2; lam sau khi consumers on dinh |
| (4) | **Live acceptance**: T-PROF-03 serialize that/FK/upsert contention tren real PG; DD-05 `createRevision` insert+pin same-tx (profiles.ts, can lease rieng); DD-03 count-only scan | Live packets rieng | Checkpoint (b) mo W1c/W3 integration (per plan-review-730 §2: (b) can publish/rollback/CAS evidence — offline da co, live dang cho) |

Ghi them (khong phai dieu kien, da co chu xu ly):
- **F-3** (dead 404 branch trong `moveActiveRevision`): observation, 3 lua chon da neu —
  coordinator disposition, khong behavior bug, khong sua trong slice nay.
- **DD-06** (client `expectedRevision?: string|number` vs server `z.number()`): server 422
  tai boundary la dung; client type fix thuoc W3/AWEB lease.
- **8-suite do pre-existing** (6 admin-shell + RED GAP `enc-meta-sentinel-runtime-refs` ve
  `result_ref` + `br12-isolation-offline`): ngoai slice; RED GAP `result_ref` can xac nhan
  khong giao snapshot path o Part sau (P1 §4(3) da flag).

## 4. Ngoai pham vi verdict (explicit non-coverage)

1. W1b SDK-CONSUME (claim→TaskContext→document-core→Connector) — chua implement (todo, khong phai pass).
2. W1c acquisition (ref resolve → decrypt sat luc fetch → safe fetch) — chua implement; them
   dieu kien (1) la hard gate.
3. Live PostgreSQL / Redis / S3 / Vault / provider that — moi evidence tren la offline/fake-tx.
4. Browser/Admin-Web mount, BFF wire ngoai `aweb04` cases trong combined 51/51.
5. `connector.ts:70` / `usage-metrics.ts:168,171` `.passthrough()` (P1 LOW-2) — ngoai duong
   W1, packet security rieng quyet.
6. Stale comment cosmetic (`submission.ts:227` ghi ":260", that `:299-301` — cc_1 audit §1
   da flag) — informational, khong anh huong verdict.

## 5. Limitations cua review nay

- Khong re-run bat ky suite nao; exit codes/counts tin theo receipts (qwen1, tester, cc_1)
  sau khi doi chieu cheo nhat quan noi bo.
- Khong doc full W2-B test files, chi receipt + findings; khong doc transcript/terminal.
- Cay dirty da lane (tester ghi 1,236 status entries tai 19:23) — ket luan file-level dua
  tren content + digest/mtime, khong baseline per-lane.
- Dinh nghia checkpoint (b) co 2 ban lech (W1-spec vs plan-review-730) — audit cc_1 §5 da
  neu; review nay dung dinh nghia plan-review-730 §2 (can publish/rollback/CAS evidence,
  offline da co o CLOSURE) va de coordinator chot gate mo W1c/W3.

**Khong commit, khong tick, khong sua source. DB window: FREE (lane nay khong giu).**
