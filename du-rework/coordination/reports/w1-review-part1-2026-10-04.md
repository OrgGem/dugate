# W1 DESIGN REVIEW — Part 1 (read-only, KHONG verdict) — 2026-10-04

**Packet:** `coordination/dispatch-specs/2026-10-04-1901-W1-DESIGN-REVIEW-PART1.md`
(run `run_069ecd6957cd`, owner Claude Code `term_19edcad8`, REVIEW-ONLY).
**Scope:** `coordination/reports/qwen1.md` muc W1-1 (audit) + W1-2 (implement/verify)
+ doi chieu code that + acceptance PLAN04-01 (`tasks/PLAN-COMPLETION-2026-10-04.md` §2 + muc 15).
**Phuong phap:** doc source truc tiep (khong chay test, khong sua gi, khong DB).
**Ket qua chung:** 6/6 findings cua W1-1 deu co code that ung ho huong fix ma W1-2
bao cao; khong phat hien fabrication trong receipt qwen1. Co 2 MEDIUM observations
moi + 1 HIGH-visibility question cho Part 2. **KHONG verdict acceptance o Part 1
theo packet — verdict la Part 2.**

---

## 1. Doi chieu claim-by-claim (doc code that)

| # | Claim trong qwen1 W1-1/W1-2 | Kiem chung doc lap | Trang thai |
|---|---|---|---|
| F-W1-1 | `submission.ts:399` ghi `JSON.stringify(profile.policy)` voi plaintext secret | `grep stringify(profile.policy)` tren `services/orchestrator/src` => **0 match**. Write path hien tai la `buildProfilePolicySnapshot(profile, ctx.tenantId)` (`submission.ts:418-421`), builder o `:502-533`, chi lay 5 field non-secret + boolean + ref, qua `safeParse` truoc khi ghi | FIX VERIFIED o code |
| F-W1-2 | `.passthrough()` 2 tang o `PinnedProfilePolicySchema` | `packages/contracts/src/runtime.ts:69`: `PinnedProfilePolicySchema = ProfilePolicySnapshotSchema` (re-export); schema moi `.strict()` ca 2 tang (`profile-policy.ts:525-531`, `:553-573`); khong con `fileUrlAuthConfig`, khong con `.passthrough()` tren duong nay | FIX VERIFIED o code |
| F-W1-3 | guard viet nhung 0 consumer | `fileUrlAuthConfigCarriesSecret` (`file-url-auth.ts:155-162`) hien co 1 consumer that: `submission.ts:512` trong builder. Them comment tai `:493-495` pin y nghia reuse | RESOLVED |
| F-W1-4 | thieu snapshot DTO + ref bat bien | `ProfileCredentialRefSchema` (`profile-policy.ts:525-531`) + `ProfilePolicySnapshotSchema` (`:553-573`) ton tai; ref `(tenantId, profileId, profileRevision)`; cot `profile_id`/`profile_revision` rieng van giu (`submission.ts:394-395`) — redundancy hop ly (queryable columns + self-describing snapshot) | ADDRESSED |
| F-W1-5 | `sourceUrl` top-level lot extension gate | `assertProfileExtensionAllowed` nhan `sourceUrl` (`submission.ts:767-795`), goi sau replay-check / truoc INSERT dau tien (`:364-371`). Logic: wrap `{url: sourceUrl}` de tai dung `fileUrlEntryName`, bo qua khi khong co path segment (Content-Disposition thuoc download leg) | FIX VERIFIED o code |
| F-W1-6 | thieu sentinel test cho snapshot | `w1-sub02` (10 test) co positive control (`leaks(profile.policy...) === true`), inject sentinel that vao ca 3 slot, deep-scan ca base64 (`leaks()` `:140-156`), assert toan bo `calls` sach chu khong chi snapshot field (`:176-178`, `:271-286`). Mutation probe 5/10 RED khi revert — thiet ke dat chuan `verify-failure-reason.md` | ADDRESSED, test design TOT |
| F-PP1 | priority van di outbox | `dispatcher.ts:55-63` doc `row.payload.priority`; `w1-sub02` case 4 assert `payload.priority === 1` (`:198-206`) | KEPT, VERIFIED |
| DD-02 | `sourceUrl` admission thuoc producer lease | Dong y: admission (`resolveEffectiveProfile` `:234-241`) la diem duy nhat biet action/profile ap dung; download leg khong biet policy. Dat gate o day la dung cho | AGREE |
| Claim fail-closed | `parsePinnedProfilePolicy` nem thay vi default | `runtime.ts:201-217`: NULL in/NULL out (legacy/pre-0026), shape sai => 422 `INVALID_SCHEMA` voi pointer `/profile_policy_snapshot/...`. Khong co default fallback | VERIFIED o code |
| Builder fail mode | snapshot khong parse duoc => 500 tai submit | `submission.ts:519-531`: `HttpError(500, 'INVALID_SCHEMA', ...)` — day la internal invariant violation (policy vua resolve tu DB nhung khong dat DTO), 500 la dung (loi server, khong phai loi caller). Claim-time fail van la 422. Phan biet 2 tang nay la sane | VERIFIED-SANE |
| Legacy parity | empty CSV admit-all; dot-sensitive; query-string khong cho extension | `policy.ts:242-244` (fold case-only), `:261-265`, `:286-292`, `fileUrlEntryName` `:307-322` (bo query/hash; tra null khi khong co segment). Test `w1-sub03` pin ca 3 hanh vi + legacy-mode bypass (`:153-162`) | VERIFIED, design co chu dich va co comment giai thich |
| Test param index | snapshot o `insert.params[15]` | Dem INSERT `submission.ts:373-424`: 16 params, snapshot la param thu 16 (index 15) — khop test `:173`, `:192`. Khong phai off-by-one | VERIFIED |

---

## 2. Findings moi tu review doc lap

### MEDIUM-1 — `parameters: { value: z.unknown() }` di nguyen vao snapshot (kenh secret ngoai 3 slot PLAN04-01)

`ProfileParametersSchema` (`profile-policy.ts:86-89`) cho `value: z.unknown()`;
snapshot DTO giu nguyen `parameters` (`:556`). Neu admin (hoac profile default)
dat secret vao mot parameter value, no di vao `profile_policy_snapshot` jsonb
thuan ma khong qua bat ky predicate nao — `fileUrlAuthConfigCarriesSecret` chi
bao 3 slot token/header/query.

Giam nhe hien co: AJV validate `effectiveInput` theo `actionDef.inputSchema`
(`submission.ts:255-263`) — voi schema chat (`additionalProperties: false`,
kieu hep) thi kenh nay hep. Nhung voi schema rong (`{type:'object'}` nhu trong
chinh fake cua test — `w1-sub02:53`, `w1-sub03:40`) thi khong co gi chan
arbitrary value.

Day khong vi pham chu acceptance PLAN04-01 (chi neu 3 slot token/header/query),
nhung la **kenh mang secret con lai duy nhat** vao snapshot sau khi F-W1-1
dong. De nghi Part 2 / security review tra loi: parameters co nam trong threat
model cua snapshot khong, hay chap nhan la admin-trusted input (giong
`connectionsOverride: [{slug, stepId}]` — da kiem, khong mang secret).

### MEDIUM-2 — `credentialRef.tenantId` la `string.min(1)`, khong phai uuid; vien mach voi W2-B P2 ref-tuple

`ProfileCredentialRefSchema` (`profile-policy.ts:525-531`): `tenantId` chi la
string non-empty, trong khi `tenant_id` trong DB la uuid va `profileId`/`profileRevision`
duoc pin cung luc voi cot `profile_id`/`profile_revision` rieng. Type long nay
khong gay bug hom nay (gia tri ghi tu `ctx.tenantId` — cung nguon voi cot
operation — nhat quan noi bo), nhung no lam **contract khong tu bao ve duoc
tinh bat bien cua ref tuple**: mot writer tuong lai co the ghi tenantId lech
khoi operation tenant ma van pass schema.

Lien he truc tiep: coordinator da bao W2-B co finding **P2 ref-tuple**
(orchestrator 8 pass / 3 fail ref mismatch — `tasks/PLAN-COMPLETION-2026-10-04.md`
§8). Toi CHUA doc receipt W2-B (ngoai scope Part 1) nen khong ket luan
2 viec co cung root cause khong — ghi day la cau hoi bat buoc cho Part 2
(xem Q1 duoi). Neu P2 mismatch nam o tuple `(tenant, profile, revision)` thi
viec siet `tenantId: z.string().uuid()` (va cross-check voi `ctx.tenantId` tai
builder) la fix re, dung huong.

### LOW-1 — `fileUrlAuthConfigCarriesSecret` coi bearer-rong la "not configured"

`file-url-auth.ts:155-162`: config `{type:'bearer'}` khong kem token/header/query
=> tra `false` => snapshot ghi `fileUrlAuthConfigured: false`. Nhat quan voi
write path (cung predicate quyet dinh encrypt), nhung ve semantic thi mot
misconfiguration (khai bearer nhung quen token) duoc ghi nhan nhu "khong cau
hinh" thay vi loi. De nghi ghi nhan, khong chan.

### LOW-2 — `.passthrough()` van ton tai ngoai duong W1 (ngoai scope, ghi de Part 2 biet)

`grep passthrough packages/contracts/src`: con `connector.ts:70` va
`usage-metrics.ts:168,171`. Duong snapshot/claim cua W1 da sach; 2 cho nay
khong nam trong write-set W1 va khong duoc review o Part 1. Neu bat ky cho nao
trong 2 cho nay nam tren duong snapshot/claim/acquisition thi la vector tuong
tu F-W1-2 — de Part 2 hoac packet security rieng quyet co mo rong pham vi khong.

---

## 3. Cau hoi cho coordinator / Part 2

- **Q1 (bat buoc Part 2):** W2-B P2 ref-tuple mismatch (3 fail) co cham tuple
  `(tenantId, profileId, profileRevision)` ma W1 vua dong khong? Neu co, MEDIUM-2
  la cung mot root cause va can siet schema + cross-check tai builder truoc khi
  W1b/W1c consume `credentialRef`.
- **Q2:** `parameters` co thuoc threat model cua snapshot khong (MEDIUM-1)? Neu
  co, can them predicate/scan cho parameter values hoac siet `value` xuong kieu
  hep hon `unknown`. Neu khong (admin-trusted), ghi ro vao acceptance de khong
  mo lai.
- **Q3 (DD-03, lap lai tu W1-2):** rows cu shape cu (co `fileUrlAuthConfig`
  plaintext) trong DB dev/live se fail closed 422 o claim — ai xac nhan co du
  lieu do khong, va rewrite/migration thuoc packet nao? Offline khong do duoc.
- **Q4:** SDK grep `profilePolicy|fileUrlAuthConfig` = 0 match (`packages/worker-sdk/src`) —
  consumer that cua `credentialRef` chua ton tai (dung DD-04). Part 2 verdict
  PLAN04-01 can W1b (SDK consume) + W1c (acquisition resolve/decrypt sat luc
  fetch). Xac nhan Part 2 se co du evidence ca 2 dau nay truoc khi verdict.

---

## 4. Phan KHONG kiem duoc trong Part 1 (gioi han co chu dich)

1. **Live DB run:** khong mo window theo packet; cac exit-code trong W1-2 §5
   (focused x3, 182/182, 8-suite-do-table) duoc tin theo receipt chu khong
   re-run doc lap. W2-B + audit doc lap se bu.
2. **Claim assembly day du (T-SUB-04):** chi doc `parsePinnedProfilePolicy`
   (`runtime.ts:201-217`) + 2 call sites (`:308`, `:1619`); chua trace toan bo
   claim response xem `pinned.profilePolicy` co lot vao worker context kenh nao
   khac khong.
3. **8 suite do pre-existing** (W1-2 §6: `br12-isolation-offline`,
   `enc-meta-sentinel-runtime-refs` RED GAP ve `result_ref`, 6 admin-shell):
   ngoai scope Part 1. Luu y rieng: RED GAP cua `enc-meta-sentinel-runtime-refs`
   nam tren ma tran sentinel cua PLAN04-01 (muc 33: sentinel "khong xuat hien o
   ... checkpoints") — Part 2 nen xac nhan gap nay khong giao voi snapshot path.
4. **`docs/21-openapi.json`** khong doi (ngoai lease W1, DTO internal) — khong
   kiem co can expose snapshot shape ra OpenAPI khong; de W3/API lane quyet.
5. **Migration 0026/0027** khong doi — chap nhan ly do (cung cot jsonb, khong can
   migration). DD-03 data-content van mo (Q3).

---

## 5. Danh gia receipt qwen1 (tinh trung thuc bao cao)

- Line-number claims da spot-check deu khop code that (submission.ts INSERT
  params, builder, gate; runtime.ts parse; policy.ts helpers; dispatcher
  priority). Khong phat hien so lieu khong co that.
- W1-2 §6 truy nguyen 8 suite do co bang chung cu the tung cai (TypeError that,
  comment RED GAP, lane ownership) — vuot chuan "khong do loi cho pre-existing
  mieng".
- W1-2 §8 tu nhan fixture sai va sua fixture (khong sua product code de test
  xanh) — dung.
- W1-HANDOFF phan biet file-tu-ghi (5) vs file-chi-doc (15) bang tool-call
  history, mtime chi corroborate — phuong phap dung, tranh bay mtime.
- Diem tru nho: `SCHEMA_KEYS` do "tu test, khong doan" nhung khong thay test nao
  assert key list nay trong 2 file moi (chi assert absence cua `fileUrlAuthConfig`
  va parse success) — khong anh huong ket luan, ghi de Part 2 khoi mat cong tim.

**Khong commit, khong tick, khong sua source. DB window: FREE (lane nay khong giu).**
**Verdict acceptance: KHONG dua o Part 1 — cho Part 2 tren bo evidence day du
(W2-B + audit doc lap).**
