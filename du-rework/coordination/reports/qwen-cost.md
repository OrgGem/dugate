# Receipt lane Qwen-Cost (COST-01..04 / token ledger / LOG-01..02)

## RESUME POINT (sau CYCLE 5 — W-COST05-SERVICE-RECON-1)

- **Packet**: W-COST05-SERVICE-RECON-1 — tich hop contracts reconciliation + budget + pricing vao UsageService (orchestrator, offline).
- **Ket luan (4 muc)**: **[PASS offline] + 1 muc [SKIP-QUALIFIED]** — bang chung exit 0 x3; rieng lenh packet `test -- tests/usage-summary.test.ts` offline = **9 skipped, exit 0** (live-gate DU_LIVE_INFRA tu skip — nghiem thu hanh vi tren DB that can Tester window, lane khong mo).
- **Da landing (cycle 5)**: `services/orchestrator/src/modules/usage/usage.ts` sua tich hop (191→460 dong / 20.960 bytes: getUsageSummary doi sang BigInt money-law + UsageSummarySchema self-check; them `projectLedgerEvent`/`reconcileUsageRows`/method `getReconciliationSummary` dung aggregateUsageEvents; budget option thu 4 dung evaluateBudgetStatus; pricing pass dung resolvePricingTier+calculateOperationCost — ingest()/project() giu NGUYEN VAN, server.ts khong cham) + `tests/usage-contracts-integration-offline.test.ts` (MOI, 352 dong, 19 test offline fake-Db, khong DB/Redis).
- **Da landing (cycle 1-4, gi nguyen)**: 4 module contracts khong doi trong cycle 5 (trừ usage-reconciliation.ts khong cham); contracts van 17/385 x3; orchestrator full offline 68 suite/1648 test xanh x supplementary run.
- **Viec con lai (ngoai packet, can packet moi)**: **producer wiring de payload moi IS ledger-shaped (hom nay 100% wire rows bi projectLedgerEvent tu choi — reconciliation path tra zero summary + rejectedRows trung thuc, Δ-D26)**; bounded read/cursor cho getReconciliationSummary (Δ-D28); route + quyen cho reconciliation/budget (Δ-D27); nghiem thu live 5 test usage-summary tren DB window (Tester); phia service COST-04 (persist budget + CAS + alert dispatch + reservation ledger that + timezone window + UI); phia service COST-03 (group-by, trend, drill-down, CSV export); pricing service CAS; priceVersion/rate-on-ledger + migration; usage-metrics chan tran (Δ-D13); Δ-D3 redaction.
- **Adjudication mo**: Δ-D1/D3/D4 (c1), Δ-D5/D7 (c2), Δ-D9..D13 (c3), Δ-D14..D23 (c4), Δ-D24..Δ-D30 (c5).
- **Blocker**: khong co trong pham vi nay.

---

## 1 — CYCLE 1: W-COST-SCHEMA-LEDGER-1 (COST-01 schema + view models, offline)

### 1.1 Pham vi va thiet ke

Doc `docs/admin-ops-monitoring-cost.md` (COST-01..04, "Quy tắc số liệu và bảo mật") va hiên trang `packages/contracts`, `packages/observability`, `services/connector/src/usage.ts`. Dat 3 artifact MOI trong `@du/contracts` (additive-only):

1. **`OperationUsageMetricsSchema`** — per-operation view model, `.strict()`:
   `operationId` (uuid), `inputTokens/outputTokens/cachedInputTokens/totalTokens` (int ≥ 0, total = in + out, cached ≤ in), `pages?`, `costMicrousd` (int ≥ 0), `costStatus ∈ {measured, estimated, pending, unpriced}` (pending/unpriced **schema-lock ve costMicrousd = 0** — thieu du lieu khong the gia dap cost da chot), `durationMs` (int ≥ 0).
2. **`UsageLedgerEventSchema`** — ledger event du chieu phan bo theo COST-01: eventId ( khoa dedup), kind initial/correction/refund + correctsEventId (moi quan he bat buoc/_cam_ theo kind, khong tu correct), tenantId/apiKeyId (pattern ID an toan, khong free-text), operationId/taskId/invocationId/attempt/stepKey, businessId/businessVersion/action, profileRevision, connectorId/connectorRevision, provider/model (snapshot luc invocation), units strict, costMicrousd + currency USD + costStatus, durationMs, occurredAt/receivedAt (RFC 3339). `.strict()` → khoa moi khoa la (prompt, content, signed url...).
3. **Adapter + view + log helper**:
   - `metricsFromProviderUsage()`: bien boundary cho usage OpenAI-style (`prompt_tokens/completion_tokens/total_tokens/prompt_tokens_details.cached_tokens`) → canonical camelCase; **copy theo allowlist** — moi khoa la (echo prompt, fingerprint, api_key nested) bi loai, khong bao giờ sang ledger; total confict cua provider **fail closed**, khong im lang sua.
   - `formatMicrousdAsUsd()` + `OperationUsageMetricsViewSchema` + `toOperationUsageMetricsView()`: `costEstimateUsd` la **string hien thi 6 so thap phan, tinh bang so nguyen thuan** (khong floatcong tien); view co tam-lock chong gia mạo (display string/settled flag phai khop int ledger).
   - `usageMetricsLogFields()`: projection scalar voi ten khoa TRANH substring redaction cua logger (xem Δ-D3).

`UsageEventSchema` (runtime.ts), `InvocationUsageSchema` (connector.ts), `UsageSchema` (operations.ts) **gi nguyen** — co regression test chungs minh van parse duoc sau khi them module.

### 1.2 Bang chung chay (do bang cach nao)

Meo do: moi lenh `run_shell_command` rieng, lay dong **`Exit Code:` literal cua wrapper tool** (khong dung marker ty dat, khong pipe qua findstr — xem lane rules). So test lay tu dong `Test Suites:/Tests:` cua jest that. Lenh chay tu `D:\Git\dugate`: `pnpm -C du-rework --filter <pkg> <cmd>`.

**Baseline TRUOC khi sua** (xac nhan san xanh, doi chieu quy ke):

| Lenh | Ket qua | Exit Code (wrapper) |
|---|---|---|
| `pnpm -C du-rework --filter @du/contracts build` | tsc -p thanh cong | `Exit Code: 0` |
| `pnpm -C du-rework --filter @du/contracts test` | 13 suites / **237** tests passed | `Exit Code: 0` |
| `pnpm -C du-rework --filter @du/observability test` | 1 suite / **22** tests passed | `Exit Code: 0` |

**SAU khi landing — 3 lan lien tiep moi lenh** (xen ke build→test→obs tung vong):

| # | contracts build | contracts test (full) | observability test |
|---|---|---|---|
| 1 | `Exit Code: 0` | `Exit Code: 0` — Test Suites: 14 passed, 14 total; Tests: **260 passed, 260 total**; Time: 4.98 s | `Exit Code: 0` — Tests: 22 passed, 22 total |
| 2 | `Exit Code: 0` | `Exit Code: 0` — 14/14; **260 passed, 260 total**; Time: 2.748 s | `Exit Code: 0` — 22 passed |
| 3 | `Exit Code: 0` | `Exit Code: 0` — 14/14; **260 passed, 260 total**; Time: 2.551 s | `Exit Code: 0` — 22 passed |

Bo sung: `pnpm -C du-rework --filter @du/contracts lint` (= tsc --noEmit -p) `Exit Code: 0` 1 lan. Suite moi chay rieng truoc do xanh: targeted `jest ... tests/usage-metrics.test.ts` → `Exit Code: 0`, **23 passed, 23 total** (2 lan xanh lien sau 1 lan do cua chinh test-cases lane — xem Δ-D0). Build emit `dist/usage-metrics.js` + `.d.ts` (da doi `dir`, exit 0). Khong full-sweep toan repo: packet pin pham vi 2 package; lan 3 suite cua 14 suite contracts + 23 test moi = toan bo scope co the verify offline. Khong de lai file log tam nao (khong can log file — chay foreground truc tiep).

### 1.3 Dinh nghia win/lose 23 test (`tests/usage-metrics.test.ts`)

**OperationUsageMetricsSchema (6)** — win: parse/bo theo schema, khong phai do mock.
1. re-export smoke: index.ts cung cấp schema, valid parse → PASS; thuat toan index thieu export → FAIL.
2. defaults zero: thieu inputTokens/outputTokens/cachedInputTokens/costMicrousd → phai = 0; pending + cost 0 duoc chap.
3. unknown-key fail-closed: 6 payload them `prompt/promptContent/completion/messages/signedUrl/apiKey` → **ca 6 bi tu choi** (day la ghi "khong co prompt trong ledger record" thanh machine-check).
4. bat dang thuc: totalTokens ≠ in+out → reject; cached > input → reject.
5. kiem chan so: negative / non-integer tokens, duration 12.5 → reject (0 hop le — "0 la so do bang khong").
6. cost-lock: pending|unpriced + costMicrousd>0 → reject; + 0 → accept; measured/estimated + >0 → accept.

**formatMicrousdAsUsd + view (4)** — 7. 0→"0.000000", 1→"0.000001", 4200→"0.004200", 1234567→"1.234567", 99M→"99.000000" (khong float artifact). 8. RangeError cho negative/non-integer/NaN. 9. view: costEstimateUsd derived + costSettled true chi khi 'measured'; pending → "0.000000" & settled false. 10. view gia mạo bi b: display string ≠ int, settled flag sai, them key prompt → reject.

**metricsFromProviderUsage (4)** — 11. OpenAI snake_case → canonical camelCase, `audio_tokens` trong details KHONG xuat hien trong metrics. 12. thieu total → tinh p+c; thieu cached → 0. 13. **sentinel hostile-input** (echoed_prompt / api_key nested / system_fingerprint / completion_echo / raw_body / signed URL): `wire.parse` con dung cho passthrough → assert co; `metrics` output JSON.stringify **khong chứa 6 sentinel**; keys metrics = dung dan allowlist 8 key. 14. fail closed: total conflict (10+5 ≠ 99) → throw; `prompt_tokens:'many'` → throw; `details.cached_tokens:'lots'` (nested non-number) → throw, **khong im lang doi ve 0**.

**UsageLedgerEventSchema (6)** — 15. happy path du chieu + currency default 'USD' + kind default 'initial'. 16. thieu bat ky chieu phan bo nao trong 8 khoa (tenantId/apiKeyId/profileRevision/connectorRevision/provider/model/invocationId/attempt) → reject. 17. ID sanitization: 'has spaces', dai 200 ky tu, '-leading-dash' → reject; **co gan y**: 'sk-live-actual-key-material' duoc chap vi **hinh dang** an toan — schema chan hinh dang ID, khong noi dung secret; chat luong nay la trach nhiem producer + vault (ghi ro de coordinator khong doc lan la "da chan key material"). 18. them `prompt` o root hoac `content` trong units → reject. 19. lien ket correction: initial+parent → reject; correction/refund thieu parent → reject; refund dung parent → accept; self-link → reject. 20. attempt=0 reject, occurredAt='yesterday' reject (RFC 3339), pending+cost 4200 reject.

**usageMetricsLogFields (2)** — 21. moi key tra ve khong match deny-substring regex (gồm `token`) → counters song qua logger redaction; JSON khong chua mauth-pattern. 22. pages chi xuat hien khi co; moi value la scalar.

**Regression (1)** — 23. `UsageEventSchema` cu (runtime.ts) van parse payload cu sau khi them module + sua index.

### 1.4 Δ-DEVIATION (de coordinator adjudicate)

- **Δ-D0 — defect cua lane, da tu sua truoc bang chung x3**: 2 lan chay dau suite do **[FAIL]** — (a) typo vong lap test lane-tao (syntax), (b) 1 assertion cua toi viet sai y nghia (extra key trong passthrough wire **duoc phep** — khong phai "string in numeric slot"). Da sua test (khong sua contract de vua test); toan bo x3 bang chung o 1.2 la sau khi xanh. Khong co [PASS] gia.
- **Δ-D1 — ten field packet vs codebase + docs**: packet ghi `prompt_tokens, completion_tokens, total_tokens, cached_tokens, cost_estimate_usd, duration_ms` (snake_case, USD float). Codebase canonical la `inputTokens/outputTokens/costMicrousd` (grep: 0 lan xuat hien `prompt_tokens` trong services/); docs quy dinh **"mọi cost dùng số nguyên micro-USD ở ledger... Không dùng số thực để cộng tiền"**. Lane uu tien docs + codebase: schema chinh dung ten camelCase + int micro-USD; ten snake_case cua packet duoc phuc vu **day du** qua `metricsFromProviderUsage` (boundary adapter); `cost_estimate_usd` ton tai nhu **`costEstimateUsd` string display-only** trong view model, derived bang so nguyen. Néu coordinator muon doi ten nguyen van sang ledger schema → day la bien quyet dinh, lane san long doi packet.
- **Δ-D2 — vi tri file**: packet cho phep contracts HOAC observability. Chon contracts: observability **khong co zod dependency** (package.json deps = {}), them zod = doi shape build package cua lane khac; ledger contract la linh vực contracts per docs ("cần migration + backfill policy, consumer compatibility" — cua contracts). observability khong bi cham (test 22/22 x3 de chungs minh).
- **Δ-D3 — FINDING lien quan buoc 3 (redaction)**: `SENSITIVE_KEY_PATTERN` cua `@du/observability/src/redaction.ts` chua alternative **`token` truing hap khong ranh gioi tu** → moi ten key chua substring 'Token' (`inputTokens`, `totalTokens`, `cached_tokens`...) bi logger thay bang `[REDACTED]` khi log cau truc. Day la false-positive voi usage counters (pattern sinh ra de chan auth token/credentials). **Lane KHONG sua**: file dang 'M' trong checkout chung (lane khac dang edit redaction.ts + observability.test.ts theo `git status`), va lane rules cam tu quyet nhat bien cua shared-file khi co lease xung dot. Workaround dang trong contracts: `usageMetricsLogFields()` (keys unitsIn/unitsOut/unitsTotal/microUsd... — da test chong deny-substring). **Kien nghi packet theo doi** cho observability lane: ranh gioi tu / exact-match / allowlist cho usage counters.
- **Δ-D4 — pham vi ro hon packet**: tieu de packet ghi "Ledger **Contract** and View Models" → lane them `UsageLedgerEventSchema` (COST-01 du chieu phan bo + dedup key + correction linkage) nhu artifact hop dong thuan tuy additive, khong thay doi 3 schema usage cu. Néu coordinator coi day la vuot scope, rollback = xoa 1 file moi + 1 dong export (khong co dependency).

### 1.5 Vi pham rang buoc? 

Khong: khong DB/Redis/S3 window, khong test live nao duoc chay (khong co suite DU_LIVE_INFRA trong 2 package nay), khong Admin UI, khong git add/commit/push/reset, file lane khac khong bi cham (footprint git = 2 file ?? moi + 1 dong trong index.ts, da dem truoc/sau: 23→24 dong, 714→748 bytes).

### 1.6 Trang thai

**COST-01 (tang schema/view): hoan thanh offline — [PASS] bang chung x3.** Downstream (migration/persist/producer wiring/COST-02..04) **chưa** được phép triển khai — cần packet tiếp theo. Δ-D1/D3/D4 cho adjudication.

---

## 2 — CYCLE 2: W-COST02-PRICING-MODEL-1 (COST-02 versioned pricing + exact cost engine, offline)

### 2.1 Pham vi va thiet ke

Doc docs/admin-ops-monitoring-cost.md (COST-02: "Bang gia co version va ngay hieu luc", [from,to), overlap check, luu priceVersion da ap dung, gia provider bao vs gia tu tinh hien rieng) + luong nghiem thu 3. Landing 1 module MOI `packages/contracts/src/pricing.ts` (additive-only; su dung OperationUsageMetrics cua cycle 1 khong sua no):

1. **`ModelPricingTierSchema`** — published tier bat bien, `.strict()`: provider? + modelId (pattern allowlist — `gpt-4o`/`claude-3-5-sonnet`/`qwen-max` hop le, free-text/secret hinh dang khong), priceVersion (int ≥ 1), cua hieu luc nua mo `[effectiveFrom, effectiveTo)` (RFC 3339, so sanh nhu INSTANT — Z va +07:00 xen ke dung), currency USD literal, rates **int micro-USD**: inputMicrousdPerMillion, outputMicrousdPerMillion, cachedInputMicrousdPerMillion? (thieu → cached danh gia FULL rate input, khong im lang discount), pageMicrousdPerPage? (o mo rong page/image theo docs). Rate chan tran MAX_SAFE_INTEGER.
2. **Validators versioned table**: `ModelPricingTableSchema` (chuoi tier, khoa (provider?,modelId,priceVersion) khong trung — DUP_PRICE_VERSION); `findPricingOverlaps(tiers)` tra danh sach cap {i,j} trung cua so [from,to) cung provider+modelId (pure, de service goi truoc publish — "Server kiểm tra overlap"); `resolvePricingTier(tiers, {modelId, at, provider?})` = gia hieu luc tai thoi diem goi, boundary from-inclusive/to-exclusive, khong doc so → undefined (producer dat costStatus 'unpriced'), da nghia → throw PRICING_OVERLAP fail-closed.
3. **Boundary tien**: `parseUsdPerMillionToMicrousd(string|number)` — decimal thuan (≤ 6 chu so thap phan, khong exponential, khong am, khong leading-zero) → int micro-USD bang BigInt; float artifact 0.1+0.2 bi tu choi. `ModelPricingTierUsdInputSchema` + `pricingTierFromUsd()` phuc vu NGUYEN VAN ten field packet (inputCostPerMillionTokensUsd/outputCostPerMillionTokensUsd/cachedInputCostPerMillionTokensUsd) → canonical tier.
4. **Engine**: `calculateOperationCost(usage, pricing): number` — **so nguyen micro-USD**, BigInt thuan: (input−cached)×rateIn + cached×rateCached(??rateIn) + out×rateOut + pages×ratePage (per-unit **round-half-up** tren phan du, cong bang so nguyen); RE-PARSE ca 2 dau vao (hostile payload fail closed truoc khi tinh); pages>0 khong co rate → PricingUnpricedUnitError (im lang = thieu gia); ket qua > MAX_SAFE → RangeError. Doc lap voi usage.costMicrousd (gia provider bao ve giu/reconcile rieng theo docs).
5. **Ngoai pham vi co y**: CAS draft→review→publish + quyen + audit la phia service (packet tiep); luu priceVersion da ap dung tren ledger record = field additive + migration (packet tiep).

### 2.2 Bang chung chay (do bang cach nao)

Meo do nhu cycle 1: moi lenh `run_shell_command` rieng, lay dong **`Exit Code:` literal cua wrapper tool**; so test lay tu dong `Test Suites:/Tests:` that. Lenh tu `D:\Git\dugate`: `pnpm -C du-rework --filter <pkg> <cmd>`; suite moi chay rieng bang `--filter @du/contracts exec jest tests/pricing.test.ts --runInBand`.

**Baseline TRUOC khi sua** (san xanh):

| Lenh | Ket qua | Exit Code (wrapper) |
|---|---|---|
| `pnpm -C du-rework --filter @du/contracts build` | tsc -p thanh cong | `Exit Code: 0` |
| `pnpm -C du-rework --filter @du/contracts test` | **14 suites / 283 tests** passed (Δ-D6: 260→283 do lane khac them test vao checkout chung — xem 2.4) | `Exit Code: 0` |
| `pnpm -C du-rework --filter @du/observability test` | 1 suite / **22** tests passed | `Exit Code: 0` |

**SAU khi landing — 3 lan lien tiep moi lenh** (xen ke build→ctests→otests tung vong):

| # | contracts build | contracts test (full) | observability test |
|---|---|---|---|
| 1 | `Exit Code: 0` | `Exit Code: 0` — Test Suites: **15 passed, 15 total**; Tests: **307 passed, 307 total** (= 283 baseline + 24 moi) | `Exit Code: 0` — Tests: **22 passed, 22 total** |
| 2 | `Exit Code: 0` | `Exit Code: 0` — 15/15; **307 passed** | `Exit Code: 0` — 22 passed |
| 3 | `Exit Code: 0` | `Exit Code: 0` — 15/15; **307 passed** | `Exit Code: 0` — 22 passed |

Bo sung: `pnpm -C du-rework --filter @du/contracts lint` (= tsc --noEmit) `Exit Code: 0`. Suite moi targeted truoc do xanh: `Exit Code: 0`, **24 passed, 24 total** (sau 1 lan do 2/24 do TEST cua lane — Δ-D8). Build emit `dist/pricing.js` + `pricing.d.ts` (+ maps) — doi `dir` exit 0. index.ts dem truC/sau: 24→25 dong, 748→776 bytes. Khong de lai file log tam.

### 2.3 Dinh nghia win/lose 24 test (`tests/pricing.test.ts`)

**Tier schema (6)** — 1. happy: parse + currency default 'USD' + re-parse idempotent (toStrictEqual); thieu cached rate → undefined. 2. `.strict()`: 5 sentinel (prompt/providerResponseBody/apiKey/signedUrl/pricingNotes) — **ca 5 bi tu choi** = gia khong the chan free-text/secret. 3. rate chan: 2.5 reject, -1 reject, 1e20 reject (>MAX_SAFE), **0 accept** (gia mien phi da do). 4. priceVersion: 0/1.5 reject, 7 accept. 5. cua so: to==from reject, to<from reject (+07:00 offset pair accept). 6. modelId shape: 4 slug that accept; 'gpt 4o'/''/'-lead'/'.dot-first' reject.

**Table + overlaps (2)** — 7. DUP_PRICE_VERSION: cung (model,version) x2 → table reject; version khac → accept. 8. adjacency [Jan,Feb)+[Feb,Mar) **khong** overlap (nua mo, khong tien 2 lan noi nua dem); intersect → [{i,j}]; open-ended trung → flag; khac model / khac provider → khong flag; provider vs khong-provider = 2 khoa khac nhau (xem Δ-D7a).

**Resolver (2)** — 9. boundary + timezone theo INSTANT: Jan1→v1, 31/1 23:59:59Z→v1, Feb1 00:00Z→v2, '06:59:59+07:00'→v1, '07:00:00+07:00'→v2. 10. model chua co gia → undefined; truoc moi cua so → undefined; at='not-a-date' → RangeError; 2 provider cung modelId + query thieu provider → throw PRICING_OVERLAP; co provider → dung tier.

**USD parser (3)** — 11. chinh xac int: '2.50'→2_500_000, '0.1'→100_000, '0.000001'→1, '0'→0, '1234567.891234'→1_234_567_891_234, '9007199254'→9_007_199_254_000_000 (sat tran duoi). 12. reject: '-1','0.0000001','1e3','1E-7','.5','2.5abc','','abc','01.5', '9007199255' (>MAX_SAFE), NaN, Infinity. 13. float khong qua duoc bien: 2.5 accept; **0.1+0.2 reject** ('0.30000000000000004'); 1e-7 reject; int micro compose chinh xac (3×100_000).

**Adapter packet-ten (2)** — 14. inputCostPerMillionTokensUsd='3.00'/output='15.00'/cached='0.30' → 3_000_000/15_000_000/300_000 canonical, re-parse OK. 15. strict + chan float: them rawProviderBody reject; 0.1+0.2 reject; '-2.50' reject; thieu cached → undefined.

**Engine (8)** — 16. 1000in@2.50/M + 500out@10/M = **7500 µ$** nguyen van; usage mang costMicrousd=999_999 'measured' van ra 7500 (doc lap gia provider). 17. cached carve-out: 600×2.5 + 400×0.3 + 500×10 = 6_620 µ$. 18. thieu cached rate → 7_500 (= full input rate, = test 16 → chungk minh khong discount tham). 19. round-half-up **tung component**: in1+out1 @2.5M → 3+3=**6** (pooled rounding se ra 5 — ghim y nghia); 1@0.4M→0; 1@0.5M→1. 20. zero do = 0; tier mien phi = 0. 21. pages 3×5000=15_000; pages>0 thieu rate → PricingUnpricedUnitError; pages=0 khong can rate; rate khong pages → 0. 22. re-parse fail-closed: them prompt / totalTokens 999 / raw_body / rate 1.5 → ZodError het. 23. tran: 1_000_000 tokens × MAX_SAFE-rate → tra dung MAX_SAFE; 5e9 tokens → RangeError (khong bao gio so dot double im lang). 24. smoke: index re-export calculateOperationCost; view model cycle 1 round-trip 7500→'0.007500', settled=false; tier prompt-only payload reject.

### 2.4 Δ-DEVIATION (de coordinator adjudicate)

- **Δ-D5 — ten gia packet vs money-law** (tiep noi Δ-D1): packet STEP 1 dat rate la `inputCostPerMillionTokensUsd` (USD, kieu float). Docs + packet STEP 3 cung yeu cau **int micro-USD khong float drift**. Lane lam ca hai: canonical tier dung **int micro-USD/1M tokens** (`inputMicrousdPerMillion`...); ten nguyen van cua packet duoc phuc vu via `ModelPricingTierUsdInputSchema` + `pricingTierFromUsd()` (chuoi decimal ≤6 so thap phan, doi BigInt chinh xac mot lan tai bien). `calculateOperationCost` tra **number = int micro-USD** (khong phai float USD).
- **Δ-D6 — drift baseline o checkout chung**: baseline contracts truoc cycle 2 = **283 test/14 suite**, khong phai 260/14 cuoi cycle 1 → lane khac da them test vao packages/contracts/tests (khong phai sua cua lane nay; lane khong adjudicate chu so huu). Ghi de doi so: 283 + 24 = 307 on dinh ca 3 vong.
- **Δ-D7 — 2 quyet dinh semantics cua lane (co the dao nguoc bang 1 packet)**: (a) `findPricingOverlaps` kho cua so theo **(provider?, modelId) strict-equal**: 'openai'+model va model-khong-provider LA 2 khoa khac nhau, khong flag overlap; (b) `resolvePricingTier` khi query thieu provider ma nhieu tier khac provider cung modelId cung hieu luc → **throw PRICING_OVERLAP** (fail closed) chu khong chon 'best'. Neu coordinator muon 'global tier lam fallback' → doi 1 ham, co test.
- **Δ-D8 — defect cua lane, da tu sua TRUOC bang chung x3**: lan targeted dau **2/24 FAIL** — (a) test 1 dung `toBe` so vat the parse-moi cua zod (identity sai, content dung), (b) test 8 viet assertion mau thuan voi chinh comment cua no. Ca 2 sua o TEST (khong sua contract); Δ-D6/x3 o 2.2 la sau khi 24/24 xanh. Khuon mau nhu Δ-D0 cycle 1 — khong co [PASS] gia.

### 2.5 Vi pham rang buoc?

Khong: OFFLINE ONLY — khong mo cua so DB/Redis/S3, khong test live; khong Admin UI; khong git add/commit/push. Footprint git cycle nay = `?? pricing.ts` + `?? pricing.test.ts` + index.ts 'M' (rieng dong 24→25 cua lane, da dem 748→776 bytes); usage-metrics.ts + tests cycle 1 khong bi cham; @du/observability khong bi cham (22/22 x3 chung minh).

### 2.6 Trang thai

**COST-02 (tang schema tier + versioned validators + engine): hoan thanh offline — [PASS] bang chung x3.** Phia service cua COST-02 (CAS draft→publish, quyen, audit, luu gia ap dung tren ledger) va downstream COST-03/04 **chưa** được phép — cần packet tiếp theo. Δ-D5/D7 cho adjudication; Δ-D1/D3/D4 cycle 1 van mo.

---

## 3 — CYCLE 3: W-COST03-RECONCILIATION-1 (COST-03 summary aggregator tang contract, offline)

### 3.1 Pham vi va thiet ke

Doc COST-03 (docs/admin-ops-monitoring-cost.md dong 46: 'Tổng hợp và đối soát' — group-by theo chieu, quy tac thoi gian occurredAt vs receivedAt duoc cong bo, tong o moi cap bang tong ledger theo cung bo loc) + quy tac dong 62-63 (int micro-USD, khong float cong tien; event trung chi tinh mot lan; token/cost cong theo event billable sau dedup/correction). Landing 1 module MOI `packages/contracts/src/usage-reconciliation.ts` (additive-only; dung UsageLedgerEvent cua cycle 1 nguyen van, khong sua no):

1. **`UsageAggregateFilterSchema`** `.strict()` + superRefine WINDOW_ORDER: tenantId/businessId (pattern SafeId allowlist), operationId (uuid), `from` (inclusive) / `to` (exclusive) RFC 3339 so sanh nhu INSTANT (Z va +07:00 xen ke dung; to <= from theo instant — ke ca 2 cach viet cung instant — reject), `timeField ∈ {occurredAt, receivedAt}` default occurredAt (xem Δ-D10).
2. **`UsageSummarySchema`** `.strict()` 5 field dung packet: inputTokens/outputTokens/totalTokens/totalCostMicrousd/eventCount — tat ca int ≥ 0 chan tran MAX_SAFE_INTEGER; superRefine invariant BigInt totalTokens = input + output.
3. **`aggregateUsageEvents(events, filter?)`**: RE-PARSE ca 2 dau vao qua schema truoc khi tinh (hostile payload → ZodError, not-array → TypeError); **dedup theo eventId chay TRUOC filter** — canonical = JSON.stringify output parse (zod don hoa thu tu key + default), cung eventId cung noi dung → tinh 1 lan; cung eventId KHAC noi dung → `UsageReconciliationConflictError` (ledger hong, khong chon ben nao — Δ-D11); loc tenant/business/operation/cua so nua mo [from,to); **tong hop BigInt thuan** (inputTokens, outputTokens, costMicrousd, eventCount); bat ky tong nao > MAX_SAFE_INTEGER → RangeError USAGE_AGGREGATE_OVERFLOW (khong bao gio so dot double im lang); correction/refund hien cong phu additive (PIN nghia trong test 23 — Δ-D12).

Yeu cau 'group' cua packet step 2 duoc phuc vu bang **phan ra dan identity** (test 24): tong cac aggregate theo tung nhom filter == aggregate ca tap — dung dinh nghia docs 'Tổng ở mọi cấp bằng tổng ledger theo cùng bộ lọc'; group-by projection day du / trend / export thuoc phia service (ngoai scope packet — Δ-D9).

### 3.2 Bang chung chay (do bang cach nao)

Cung meo do cycle 1/2: moi lenh `run_shell_command` rieng, lay dong **`Exit Code:` literal cua wrapper tool** (x3 khong pipe qua findstr de dong exit cua wrapper phan anh lenh that); so test lay tu dong `Test Suites:/Tests:` cua jest that. Lenh chay tu `D:\Git\dugate`: `pnpm -C du-rework --filter <pkg> <cmd>`.

**Baseline TRUOC khi sua** (dau cycle 3, san xanh): build `Exit Code: 0`; contracts test **15 suites / 307 tests** `Exit Code: 0` (khong drift so voi cuoi cycle 2); observability **22 tests** `Exit Code: 0`.

**Targeted TRUOC** (suite moi chay rieng): `pnpm -C du-rework --filter @du/contracts exec jest tests/usage-reconciliation.test.ts --runInBand` → `Exit Code: 0`, **26 passed, 26 total** ngay lan dau — **khong co lan do nao do lane tu gay ra cycle nay** (thang hang voi Δ-D0/Δ-D8 cua cycle 1/2).

**SAU khi landing — 3 lan lien tiep moi lenh**:

| # | contracts build | contracts test (full) | observability test |
|---|---|---|---|
| 1 | `Exit Code: 0` | `Exit Code: 0` — Test Suites: **16 passed, 16 total**; Tests: **333 passed, 333 total** (= 307 baseline + 26 moi); Time: 7.526 s | `Exit Code: 0` — Tests: **22 passed, 22 total** |
| 2 | `Exit Code: 0` | `Exit Code: 0` — 16/16; **333 passed**; Time: 4.909 s | `Exit Code: 0` — 22 passed |
| 3 | `Exit Code: 0` | `Exit Code: 0` — 16/16; **333 passed**; Time: 4.368 s | `Exit Code: 0` — 22 passed |

Bo sung: `pnpm -C du-rework --filter @du/contracts lint` (= tsc --noEmit) `Exit Code: 0` 1 lan. Build emit `dist/usage-reconciliation.js` + `usage-reconciliation.d.ts` (+ maps) — doi `dir` `Exit Code: 0`. index.ts dem truoc/sau: 25→26 dong, 776→817 bytes. 307 test cu van xanh trong 333 → usage-metrics.ts, pricing.ts va 13 suite lane khac khong bi anh huong. Khong de lai file log tam nao.

### 3.3 Dinh nghia win/lose 26 test (`tests/usage-reconciliation.test.ts`)

**Filter schema (5)** — 1. empty filter hop le + timeField default 'occurredAt' + tu chieu from-only/to-only chap nhan. 2. `.strict()`: 5 sentinel prompt/apiKeySecret/groupBy/limit/signedUrl → **ca 5 bi tu choi** (filter khong the mang key free-text/paging/groupBy bo trom). 3. hinh dang sai: tenantId 'bad tenant', businessId rong, operationId khong uuid, from '2026-03-01 00:00', to 'next tuesday' → reject. 4. window order: to==from reject; to<from reject; **from '+07:00' vs to 'Z' cung instant → reject** (so sanh instant, khong so sanh xau). 5. timeField enum dong: 'createdAt'/null → reject.

**Summary schema (3)** — 6. summary hop le + all-zero (ky trong) la ket qua phap ly. 7. `.strict()`: costUsd (float display) va distinctOperations **khong duoc chen trom** → reject (5 field dung packet; mo rong la quyet dinh moi). 8. chan so: -1 / 7500.5 / 1e20 reject; totalTokens ≠ in+out (1501) reject — invariant tinh bang BigInt.

**Aggregate (18)** — 9. zero events (ca khi co filter) → object all-zero nguyen van, eventCount 0. 10. khong filter 3 event → toStrictEqual {3010, 1500, 4510, 22500, 3} chinh xac int + round-trip schema. 11. loc tenantId → {3000, 1500, 4500, 22500, 2}; tenant khong ton tai → zero summary. 12. loc businessId → {10, 0, 10, 0, 1}. 13. loc operationId bat ca 2 invocation/attempt khac nhau cua CUNG operation → count 2 (docs: mot operation nhieu invocation). 14. filter ket hop = AND (tenant+biz+window → 1 event; doi chieu tenant sai thi business khong cuu duoc → 0). 15. nua mo [from,to): from-instant VAO, to-instant NGOAI, to−1ms VAO. 16. window theo INSTANT khong theo text: event '+07:00' vs bound 'Z' chay dung ca hai huong; filter '+07:00' vs event 'Z' cung dung. 17. timeField doi dong ho tra ra dap an KHAC nhau tren cung event+window (ocurredAt trong ky, receivedAt ngoai ky → 1 vs 0). 18. dedup 3 lan phat cua 1 eventId (ban 2 dao thu tu key + thieu kind duoc zod default, ban 3 explicit kind) → **tinh 1 lan** {7500, count 1}. 19. conflict cung eventId khac costMicrousd → UsageReconciliationConflictError + .eventId == 'evt-0001' + message USAGE_EVENT_CONFLICT (khong chon ben nao, khong im lang). 20. conflict duoc phat hien TRUOC filter: copy ngoai cua so van throw (integrity ledger khong phu thuoc query). 21. engine re-parse: event them key prompt → ZodError; costMicrousd 7500.5 → ZodError; filter them groupBy / tenantId 42 → ZodError; events not-array → TypeError. 22. pending event → token + count vao tong, tien = 0; pending+cost 5 khong the xay ra (schema khoa o nguon — test pin lai). 23. **PIN semantics hien tai**: refund event correctsEventId='evt-0001' +200 → 7700 additive (netting se dao test nay — Δ-D12). 24. **phan ra dan identity**: tong theo tenant-a + tenant-b == ca tap (du 5 field), tuong tu theo business — docs 'Tổng ở mọi cấp bằng tổng ledger theo cùng bộ lọc'. 25. overflow safeguard: 3×3e15 = 9e15 ≤ MAX_SAFE → **int chinh xac**; them event thu 4 vuot tran → RangeError; chi tinh tong (6e15 in + 6e15 out, tung vung an toan) → RangeError neu ten totalTokens; 1 event cost 1e20 (event schema KHONG chan tran — xem Δ-D13) → aggregator la bien fail-closed bang RangeError. 26. purity + determinism: input array khong bi mutation (doi snapshot sau), filter object khong bi doi, 2 lan chay cho cung ket qua, `aggregateUsageEvents` re-export tu `src/index.ts` chay ra ket qua giong het import truc tiep.

### 3.4 Δ-DEVIATION (de coordinator adjudicate)

- **Δ-D9 — 'group' khong co API first-class o tang contract**: packet step 1 chi ten filter/summary/aggregate; step 2 yeu cau test 'group'. Lane phuc vu bang identity phan ra dan theo filter (test 24) — dung dinh nghia docs 'tong o moi cap bang tong ledger theo cung bo loc'. Néu muon helper `groupBy(dimension) → Map<key, UsageSummary>` ngay o contracts (server goi lai) → packet moi, 1 ham + test, khong dao nguoc API hien tai.
- **Δ-D10 — them `timeField` khong co trong packet**: docs COST-03 **bat buoc** 'quy tắc thời gian occurredAt so với receivedAt ... được công bố' — [from,to) khong noi ro dong ho nao la khong xac dinh. Lane giai quyet: enum dong {occurredAt, receivedAt}, default occurredAt (thoi diem invocation bat bien — dung cho doi soat hoa don); receivedAt loi view ingest-lag. Dao nguoc default / xoa field = 1 dong + test 17.
- **Δ-D11 — mo rong 'loai bo duplicate' thanh conflict fail-closed**: packet chi nau dedup theo eventId. Hai event cung eventId KHAC noi dung la ledger hong (UsageLedgerEvent la row bat bien — COST-01), khong phai duplicate delivery → `UsageReconciliationConflictError` thay vi ngam dinh giu ban dau / ban cuoi. Check nay chay TRUOC filter (test 20): mau cua ledger phai duoc bao du ke ca khi query khong cham den no.
- **Δ-D12 — correction/refund CHUA netting (quyet dinh semantics mo)**: hien tai moi unique event cong additive — PIN bang test 23 de dao nguoc 1 test khi coordinator quyet. Ly do khong tu quyet: costMicrousd khong am nen refund khong the tru truc tiep; supersede (event moi thay the event theo chuoi correctsEventId) khac additive o tien te that; day thuoc phia ledger semantics cua COST-01/03 chu packet nay khong yeu cau.
- **Δ-D13 — FINDING: `UsageLedgerEventSchema` khong chan tran gia tri tien/counter** (costMicrousd/units = int ≥ 0, 1e20 parse hop le) → producer co the ghi event ma moi lan aggregate deu RangeError (test 25 pin hanh vi bien cua aggregator). Kien nghi packet sau: them `.max(Number.MAX_SAFE_INTEGER)` vao usage-metrics.ts (lane TU SUA vi do la file cycle-1 + ca lane doc ledger; schema change co the anh huong fixture lane khac). Cung muc: docs COST-03 yeu cau hien thi distinct-operations + cached tokens/pages theo nhom — 5 field summary cua packet chua phan anh; `UsageSummarySchema.strict()` hien TUC CHOI key la chen trom (test 7), mo rong la quyet dinh packet sau.

### 3.5 Vi pham rang buoc?

Khong: OFFLINE ONLY — khong mo cua so DB/Redis/S3, khong test live nao duoc chay; khong Admin UI; khong git add/commit/push. Footprint git cycle nay = `?? usage-reconciliation.ts` + `?? usage-reconciliation.test.ts` + index.ts 'M' (dong 25→26 cua lane, dem 776→817 bytes); usage-metrics.ts, pricing.ts, @du/observability khong bi cham (307 test cu + 22 obs van xanh trong 333/22 x3 la chung minh).

### 3.6 Trang thai

**COST-03 (tang contract: filter + aggregator pure BigInt + dedup/conflict + overflow guard): hoan thanh offline — [PASS] bang chung x3.** Phia service cua COST-03 (group-by day du theo chieu phan quyen, trend buckets, drill-down, CSV export, man hinh Usage & Cost) va COST-04 **chưa** được phép triển khai — cần packet tiếp theo. Δ-D9..Δ-D13 cho adjudication; cac Δ cu (D1/D3/D4/D5/D7) van mo.

---

## 4 — CYCLE 4: W-COST04-BUDGET-ALERT-1 (COST-04 budget/threshold/reservation tang contract, offline)

### 4.1 Pham vi va thiet ke

Doc COST-04 (docs/admin-ops-monitoring-cost.md: chu ky ngay/thang, nguong token+USD, muc canh bao, owner, kenh nhan, policy alert-only/block-new-invocations; reservation truoc provider call dung CHUNG quota scope voi actual usage; dang chay/UNKNOWN duoc tinh vao phan giu cho) + luong nghiem thu 4 (canh bao 80% + hard cap 100% tren fixture co reservation) + quy tac int micro-USD. Landing 1 module MOI `packages/contracts/src/usage-budget.ts` (additive-only; tieu dung UsageSummary cycle 3 nguyen van) + 1 fix lane-so-huu (Δ-D22, xem 4.4):

1. **`BudgetPeriodSchema` / `BudgetPolicySchema`** — enum dong, case-sensitive dung packet: DAILY|MONTHLY va ALERT_ONLY|BLOCK_NEW_INVOCATIONS.
2. **`BudgetConfigSchema`** `.strict()`: tenantId/owner dung pattern ID an toan cua ledger (free-text/URL/co dau cach bi tu choi — structurally khong the chan secret); tokenLimit + costLimitMicrousd la int BAT BUOC ≥ 1 chan MAX_SAFE_INTEGER (0 bi tu choi — 0 la khoa tenant, khong phai budget; Δ-D16); warnThresholdPercent int 1..100 default 80; alertChannels mang ≤ 20 sanitized id (khong phai webhook URL — Δ-D18); default cua alertChannels la thunk → moi row parse ra co mang rieng (khong share mutable []).
3. **`evaluateBudgetStatus(budget, currentUsage, inFlightReservation?)`** → dung 6 field packet `{usagePercent, warnThresholdExceeded, limitExceeded, action, remainingTokens, remainingCostMicrousd}`. RE-PARSE ca 3 dau vao truoc khi tinh (pattern cycle 2/3); tong = usage + reservation tinh BigInt thuan; **limitExceeded = (usage+res) ≥ limit** o bat ky chieu nao (cham tran = vuot — Δ-D14); usagePercent = MAX hai chieu, **floor** bang phep chia nguyen BigInt (usage*100/limit — khong bao gio Number((x/y)*100)); warnThresholdExceeded = percent ≥ threshold (tinh tren floor, pin boundary); action: limitExceeded → BLOCK (policy BLOCK_NEW_INVOCATIONS) hoac WARN (ALERT_ONLY), nguoc lai warn → WARN, khac ALLOW; remaining = limit − (usage+res), clamp ve 0 tai/vuot tran, dung theo tung chieu; moi tong hoac percent vuot MAX_SAFE_INTEGER → RangeError USAGE_BUDGET_OVERFLOW (ten field duoc neu trong message) — khong bao gio so dot double im lang. Ham KHONG doc dong ho: cua so DAILY/MONTHLY [from,to) do caller loc bang aggregateUsageEvents (Δ-D19).
4. **`BudgetEvaluationSchema`** xuat khau `.strict()` + 2 invariant tu-kiem-chung (limitExceeded ⟺ usagePercent ≥ 100; duoi tran thi ca 2 remaining > 0) — de service luu receipt cua evaluation roi re-validate duoc (Δ-D17).

### 4.2 Bang chung chay (do bang cach nao)

Cung meo do cycle 1-3: moi lenh `run_shell_command` rieng, lay dong **`Exit Code:` literal cua wrapper tool**, x3 khong pipe; so test lay tu dong `Test Suites:/Tests:` that. Lenh tu `D:\Git\dugate`: `pnpm -C du-rework --filter <pkg> <cmd>`; targeted: `pnpm -C du-rework --filter @du/contracts exec jest tests/usage-budget.test.ts --runInBand`.

**Baseline TRUOC khi sua** (dau cycle 4): build `Exit Code: 0`; contracts test `Exit Code: 1` — 16 suites / 355 tests, **1 FAIL khong phai cua lane**: `tests/operations-list-contract.test.ts` (thu tu expected cua OPERATIONS_LIST_SORT_VALUES lech source — file cua lane khac trong checkout chung; lane KHONG sua, ghi Δ-D23); observability `Exit Code: 0` 22/22. Drift 333→355 do lane khac them test (Δ-D23).

**Targeted lan 1: 29/30** — test 24 RED that: phat hien **defect trong UsageSummarySchema cycle 3** (zod v3 chay refinement tren gia tri dirty → BigInt(1.5) thoat RangeError khoi parse thay vi ZodError). Lane SUA SOURCE lane-so-huu (guard Number.isInteger), khong che test (Δ-D22). Sau fix: targeted **30/30** `Exit Code: 0` + regression cycle 3 `Exit Code: 0` **26/26**. Foreign suite da TU xanh truoc formal x3 (lane khac fix trong checkout chung — formal output khong con FAIL line).

**SAU khi landing — 3 lan lien tiep moi lenh** (xen ke build→ctests→otests tung vong):

| # | contracts build | contracts test (full) | observability test |
|---|---|---|---|
| 1 | `Exit Code: 0` | `Exit Code: 0` — Test Suites: **17 passed, 17 total**; Tests: **385 passed, 385 total** (= 355 baseline + 30 moi); Time: 9.637 s | `Exit Code: 0` — Tests: **22 passed, 22 total** |
| 2 | `Exit Code: 0` | `Exit Code: 0` — 17/17; **385 passed**; Time: 4.036 s | `Exit Code: 0` — 22 passed |
| 3 | `Exit Code: 0` | `Exit Code: 0` — 17/17; **385 passed**; Time: 4.681 s | `Exit Code: 0` — 22 passed |

Bo sung: `pnpm -C du-rework --filter @du/contracts lint` (= tsc --noEmit) `Exit Code: 0`. Build emit `dist/usage-budget.js` + `usage-budget.d.ts` (+ maps) — doi `dir` `Exit Code: 0`. Dem file: usage-budget.ts 232 dong/10.765 B; usage-budget.test.ts 462 dong/21.738 B; usage-reconciliation.ts 245→255 dong, 10.522→10.937 B (Δ-D22); index.ts 26→27 dong, 817→850 B. Khong de lai file log tam nao.

### 4.3 Dinh nghia win/lose 30 test (`tests/usage-budget.test.ts`)

**Config schema (7)** — 1. enum dong case-sensitive: daily/alert_only/SOFT_BLOCK/null/80 reject het. 2. happy: defaults (warn 80, channels []) duoc dien; re-parse idempotent toStrictEqual; **hai row parse ra khong dung chung mot mang alertChannels** (thunk default). 3. `.strict()`: 6 sentinel costUsd/groupBy/webhookUrl/expectedRevision/budgetNotes/apiKeySecret → **ca 6 bi tu choi** (budget khong the chan float USD, groupBy bo trom, webhook secret). 4. tenantId/owner la sanitized id: 'ops team' reject, 42 reject, rong reject, URL reject; 128 ky tu accept, 129 reject. 5. warnThresholdPercent: 0/101/1.5/'80'/null reject; 1/100 accept. 6. limit: 1000.5/-1/'1000'/0/1e20/Infinity/null reject; thieu field reject; 1 va MAX_SAFE accept — **PIN Δ-D16 (0 tu choi)**. 7. alertChannels: khong-mang/'ch a'/webhook-URL/21 phan tu reject; ≤20 va [] accept.

**Evaluate (23)** — 8. zero usage → toStrictEqual dung 6 field packet (khong them khong sot), ALLOW, remaining = nguyen cap. 9. duoi nguong (50/50%) ALLOW. 10. **PIN Δ-D14/D15**: cham nguong chinh xac (800/1000 va 20000/25000 = 80% floor) → warn TRUE, action WARN, limitExceeded VAN false. 11. sat-duoi nguong (79%) ALLOW, remaining le 201/5001. 12. vuot nguong chua tran: WARN; ALERT_ONLY va BLOCK cho ket qua giong het nhau khi chua cham tran. 13. **PIN Δ-D14**: cham tran (≥) = limitExceeded; ALERT_ONLY chan action o WARN — percent 100, remaining clamp 0/0. 14. vuot tran ALERT_ONLY: WARN voi percent 125 trung thuc. 15/16. BLOCK_NEW_INVOCATIONS tai tran va vuot tran → BLOCK; test 15 con cho thay remaining chieu chua vuot van duoc giu (cost 5000) — chan chieu vuot, khong phong thua. 17. reservation day vuot nguong canh bao (70% + 15% → 85% WARN; remaining = cap − (usage+res) = 150/3750). 18. **PIN Δ-D14**: reservation dang chay tinh 100% vao blocking → BLOCK dung tai nguong (docs: dang chay/UNKNOWN duoc tinh vao phan giu cho). 19. thieu vs zero-reservation cho cung ket qua; null va 42 → ZodError. 20. hai chieu doc lap: cost vuot tran (104%) chan WARN/BLOCK du token moi 50%; remaining tung chieu clamp. 21. **PIN Δ-D15**: usagePercent = MAX hai chieu va KHONG doi khi threshold doi (99 giuyen voi warn 30/99/100); threshold 100 → warn false + ALLOW (flag vs action tach roi). 22. floor chia nguyen chinh xac: 100/1000 = 10 (khong 9.999 do float); 333 → 33; le-chan 99 → 9 khong luon thanh 10. 23. hostile budget re-parse: tokenLimit '1000', tenantId 42, costLimit 25000.5, thieu tenantId, policy 'ALERT', budget null/'budget' → ZodError het. 24. hostile usage/reservation: thieu eventCount, float tokens, string money, totalTokens ≠ in+out, extra key 'prompt' tren reservation → **ZodError het** (chinh test nay bat Δ-D22). 25. remaining chinh xac duoi tran (750/20000; co res: 550/15000) va 0 khi vuot (percent 140). 26. MAX_SAFE sat ranh: limit=usage=MAX_SAFE → percent 100, BLOCK, khong crash. 27. overflow safeguard: 5e15+5e15 vuot MAX_SAFE → RangeError USAGE_BUDGET_OVERFLOW ca hai chieu (message ten field); limit 1 vs usage 9e15 → RangeError tai guard usagePercent. 28. purity+determinism: JSON-snapshot 3 dau vao khong doi; 2 lan chay giong het; output tu validate BudgetEvaluationSchema. 29. **integration cycle 3→4**: 2 ledger event → aggregateUsageEvents that → evaluateBudgetStatus (4500/4000 tokens = 112%) → BLOCK, remaining cost 7500 — khong interface gap. 30. smoke: index re-export la CUNG function object va cho cung verdict.

### 4.4 Δ-DEVIATION (de coordinator adjudicate)

- **Δ-D14 — cham tran = vuot (>=), khong phai (>)**: reservation giu TRUOC provider call cho goi dang chay/UNKNOWN (docs COST-04); voi strict > thi ngan sach da duoc giu kin 100% van con mo them 1 invocation nua (double-spend ranh). Lane pin (usage+res) ≥ limit = limitExceeded. Dao nguoc = 1 phep so sanh + cac test 13/15/18.
- **Δ-D15 — usagePercent = MAX hai chieu, so nguyen floor BigInt**: packet tra 1 percent duy nhat cho 2 dimension (token vs tien); lane chuan hoa max(floorToken, floorCost) voi floor = usage*100/limit phep chia nguyen. Quan he 'percent ≥ 100 ⟺ limitExceeded' duoc ep bang invariant cua chinh BudgetEvaluationSchema (Δ-D17). Khong co float trong bat ky cong thuc phan tram nao.
- **Δ-D16 — ca hai limit BAT BUOC va ≥ 1**: packet liet ke tokenLimit/costLimitMicrousd nhu field, khong ghi optional. Lane chuan hoa required + chan 0 (0 = khoa moi invocation, la tenant-state chu khong phai budget). Neu coordinator muon khong gioi han mot chieu → doi optional + semantics = quyet dinh packet sau (hien `.strict()` tu choi null: Infinity/null khong luot qua duoc).
- **Δ-D17 — xuat khau BudgetEvaluationSchema + 2 invariant**: packet chi yeu cau tra object; lane them schema `.strict()` export de service khac luu receipt cua evaluation va re-validate. Them surface additive, khong dao nguoc ai.
- **Δ-D18 — alertChannels la sanitized id ≤ 20, KHONG phai webhook URL**: docs cam log/xuat secret; webhook URL vat than la secret → lane khoa bang pattern ID an toan (test 4/7 chung minh URL bi tu choi tai schema). Resolution id → kenh that thuoc service/vault. owner cung la id, khong phai ten hien thi free-text.
- **Δ-D19 — ham khong doc dong ho**: cua so DAILY/MONTHLY [from,to) + timezone cat luc nao la quyet dinh service/UI (docs bat buoc quy tac thoi gian duoc cong bo — cycle 3 da co published timeField rule); evaluateBudgetStatus tinh tren usage DA loc, test 29 noi truc tiep output cua aggregateUsageEvents. Lane khong tu dat hom nay/thang nay trong contracts.
- **Δ-D20 — inFlightReservation reuse UsageSummary**: reservation dung y schema strict 5 field cua cycle 3 (caller giu eventCount = 0 neu khong co ly do dem); them dedicated ReservationShape = duplication khong can thiet. Reservation null duoc xu ly nhu khong co; null explicit → ZodError (test 19).
- **Δ-D21 — scope theo PACKET (hen hon docs)**: docs COST-04 noi budget co the gan API key/profile/business optional; packet chi cho tenantId. Lane theo packet; them apiKeyId?/profileId?/businessId? la additive quyet dinh sau.
- **Δ-D22 — FIX defect lane-so-huu (cycle 3) do test cycle 4 phat hien**: `UsageSummarySchema.superRefine` goi `BigInt()` truc tiep tren gia tri co the DIRTY (zod v3 van chay refinement sau khi base check fail) → parse payload float hostile thoat **RangeError** thay vi **ZodError** — gay roi contract 'schema fail = ZodError' ma ca 3 cycle deu dua vao. Lan targeted dau 29/30 RED o test 24; lane sua SOURCE (guard Number.isInteger 3 field token truoc khi BigInt, 245→255 dong) thay vi che test, vi day la defect that. Regression cycle 3 26/26 + toan bo formal x3 sau fix.
- **Δ-D23 — baseline dau cycle 4 CO 1 RED cua lane ngoai + drift +22**: contracts baseline `Exit Code: 1` (16/355) do `tests/operations-list-contract.test.ts` fail — thu tu expected cua OPERATIONS_LIST_SORT_VALUES lech source; file cua lane khac trong checkout chung, lane KHONG cham; foreign suite da tu xanh truoc formal x3 (lane khac sua). 333→355 la them test cua lane khac. Bang chung [PASS offline] nay dua tren checkout da co sua tu oai ngoai — ghi de coordinator biet.

### 4.5 Vi pham rang buoc?

Khong: OFFLINE ONLY — khong mo cua so DB/Redis/S3, khong test live nao duoc chay; khong Admin UI; khong git add/commit/push. Footprint git cycle nay = `?? usage-budget.ts` + `?? usage-budget.test.ts` + index.ts 'M' (dong 26→27 cua lane, dem 817→850 bytes) + usage-reconciliation.ts sua NOI BO lane-so-huu (Δ-D22 — file van `??` vi chua bao gio commit). @du/observability khong bi cham (22/22 x3). usage-metrics.ts, pricing.ts khong bi cham.

### 4.6 Trang thai

**COST-04 (tang contract: BudgetConfig + evaluateBudgetStatus reservation-aware + overflow guards + fix Δ-D22): hoan thanh offline — [PASS] bang chung x3.** Phia service COST-04 (persist + quyen + CAS budget config, alert dispatch, reservation ledger that, cua so DAILY/MONTHLY timezone, UI Ngan sach) va cac service COST-02/03 **chưa** được phép triển khai — cần packet tiếp theo. Δ-D14..Δ-D23 cho adjudication; cac Δ cu (D1/D3/D4/D5/D7/D9..D13) van mo.

---

## 5 — CYCLE 5: W-COST05-SERVICE-RECON-1 (tich hop contracts vao UsageService, orchestrator, offline)

### 5.1 Pham vi va thiet ke

Doc du-rework/AGENTS.md (4 muc SPECIFIED/IMPLEMENTED/VERIFIED/ACCEPTED — receipt khong tu claim pass gia) + Muc 4 cua receipt nay + services/orchestrator/src/modules/usage/usage.ts. Seam theno chai: payload DB usage_events la WIRE UsageEventSchema (frozen, runtime.ts:382 — units/measurement/occurredAt) KHONG phai UsageLedgerEvent (can 12 field phu: tenantId, apiKeyId, attempt, stepKey, businessId/Version, action, profileRevision, connectorId/Revision, costStatus, durationMs, receivedAt). Lane khong lat seam: mapper TU CHOI tung row thieu field (never-fabricate), khong dung gia tri dinh.

Sua usage.ts (ingest()/project() giu NGUYEN VAN; server.ts KHONG cham): (1) getUsageSummary giu nguyen response shape + grouping semantics, nhung cong don nay BigInt + chan MAX_SAFE + Location-ty check bang UsageSummarySchema (khong con floating-point += tien trong duong tong — pin Δ-D25); them options thu 4 {budget?, inFlightReservation?} → evaluateBudgetStatus (COST-04) tren UsageSummary toan bo cua so (eventCount = window rows); khong options → response byte-identical (key-set test 7). (2) projectLedgerEvent(payload): safeParse UsageLedgerEventSchema — ok:true passthrough, ok:false + missingFields (invalid_type + required, sorted, on dinh). (3) method moi getReconciliationSummary(tenantId, filter?, tiers?) → SQL doc theo tenant (RES-07 join operations) → reconcileUsageRows pure: project → aggregateUsageEvents (dedup + [from,to) theo timeField cong bo cycle 3) → pricing pass optional (COST-02): resolvePricingTier(model, occurredAt, provider) + calculateOperationCost (engine tu re-parse); PricingUnpricedUnitError/thieu tier dem unpriced (khong im lang 0); pricing chay tren Map DA DEDUP — duplicate delivery tinh tien 1 lan (test 18); RangeError → HttpError 503, conflict → HttpError 500 USAGE_LEDGER_CONFLICT (duck-type name/message — bai hoc SEC-INT-01 class-split src/dist).

Ten ham packet: calculateTieredCost KHONG ton tai trong @du/contracts (grep 0); ham that la calculateOperationCost (cycle 2) — lane dung ten THAT + gop resolvePricingTier thanh pricing pass (Δ-D24).

### 5.2 Bang chung chay (do bang cach nao)

Cung meo do (moi lenh run_shell_command rieng, dong Exit Code: literal cua wrapper, x3 khong pipe). Lenh packet: pnpm -C du-rework --filter @du/contracts test / pnpm -C du-rework --filter @du/orchestrator test -- tests/usage-summary.test.ts (pnpm `--` khong duoc bo — positional sau no) / lint (= tsc --noEmit).

Baseline TRUOC khi sua (dau cycle 5, tree sach cho lane): contracts 17/385 Exit Code: 0; orchestrator lint Exit Code: 0; lenh packet usage-summary offline Exit Code: 0 — 1 skipped suite, 9 skipped tests (gate DU_LIVE_INFRA tu skip — KHONG phai pass, [SKIP-QUALIFIED], Δ-D30); br12-isolation-offline 18/18 Exit Code: 0. Khong co foreign red (khac Δ-D23 cycle 4).

Targeted lan 1: suite fail-to-compile (TS2739 x3 — options.budget khai kieu BudgetConfig (post-parse) trong khi goi tru parse phai BudgetConfigInput) — loi LANE, sua SOURCE (doi sang BudgetConfigInput, export san cua cycle 4). Lan 2: 17/19 — 2 RED deu o literal test cua lane (test 3: fixture da co measurement measured → expectation measured; test 10: thieu stepKey trong missingFields). Sua TEST (source dung). Lan 3: 19/19 Exit Code: 0. Khuon mau Δ-D0/D8/D22 lap lai: moi lan do do cua lane deu duoc sua TRUOC formal x3; khong co [PASS] gia.

SAU khi landing — 3 lan lien tiep (moi vong LINT→NEW→BR12→PKTC→CTR):

| # | orch lint | orch new suite | orch br12 | orch usage-summary (live-gated) | contracts test |
|---|---|---|---|---|---|
| 1 | `Exit Code: 0` | `Exit Code: 0` — **19 passed** | `Exit Code: 0` — 18 passed | `Exit Code: 0` — **9 skipped** | `Exit Code: 0` — **385 passed** |
| 2 | `Exit Code: 0` | `Exit Code: 0` — 19 passed | `Exit Code: 0` — 18 | `Exit Code: 0` — 9 skipped | `Exit Code: 0` — 385 |
| 3 | `Exit Code: 0` | `Exit Code: 0` — 19 passed | `Exit Code: 0` — 18 | `Exit Code: 0` — 9 skipped | `Exit Code: 0` — 385 |

Bo sung (1 lan supplementary, no-drift toan package): full orchestrator suite offline pnpm -C du-rework --filter @du/orchestrator test → Test Suites: 68 passed / 17 skipped (85); Tests: 1648 passed / 209 skipped (1857); Exit Code: 0 — khong suite nao cua lane khac bi do tich hop nay. Dem file: usage.ts 191→460 dong / 20.960 B; test MOI 352 dong / 16.116 B. Khong file log tam.

### 5.3 Dinh nghia win/lose 19 test (tests/usage-contracts-integration-offline.test.ts — fake Db, zero DB/Redis)

getUsageSummary money-law (7) — 1. W39-C fixture numbers (acme x-1 30/6/mixed/10; other y-2 4/4/pages3/2; totals {2,34,10,3,12}) reproduce toStrictEqual CA response = zero-drift hanh vi live-suite pinned. 2. provider/model non-string collapse (unattributed) + sort legacy. 3. amount thieu/khong-phai-number van SKIP nhu vong legacy (khong 503 hoa du lieu thieu — chi hong THAT). 4. PIN Δ-D25: stored float 1.5 → HttpError 503 (legacy cong noi ngu vao tong). 5. stored -5 → 503. 6. BigInt ceiling: 4.5e15+4.5e15 = 9e15 CHINH XAC; 5e15+5e15 vuot MAX_SAFE → 503 message neu ten costMicrousd. 7. khong options → key-set response van [from,rows,tenantId,to,totals] — khong bao gio co budget key.

Budget option COST-04 (2) — 8. fixture 44 tokens / tokenLimit 55 → cham nguong 80% THAT qua evaluateBudgetStatus: WARN, remaining 11/999999988. 9. tokenLimit 60 policy BLOCK: usage minh 44 → ALLOW; them inFlightReservation 16 tokens → 60 ≥ 60 → BLOCK, remaining 0 — reservation vao blocking QUA SERVICE THAT (khong chi qua test contracts).

Boundary projector (2) — 10. wire payload → ok:false, missingFields toEqual CHINH XAC 13 key sorted (action/apiKeyId/attempt/businessId/businessVersion/connectorId/connectorRevision/costStatus/durationMs/profileRevision/receivedAt/stepKey/tenantId); khong chan measurement/provider/units (field co san/extra KHONG phai thieu) — never-fabricate pin bang danh sach trang thai. 11. ledger payload → ok:true passthrough.

Reconciliation COST-03 (4) — 12. wire-only tenant → summary zero trung thuc + rejectedRows 2 (khong gia mau). 13. 2 ledger events + 1 duplicate delivery → projectedEvents 3 nhung summary {3000,1500,4500,22500,2} — dedup cycle 3 chay TRONG service path. 14. filter {from 10:30Z} qua getReconciliationSummary → chi evt-l2 duoc dem (window tren occurredAt, SQL khong loc thoi gian — Δ-D28); assert SQL chua o.tenant_id = $1 + params [TENANT] (tenant scope van nam o server, truoc aggregate). 15. 2 row cung eventId khac cost → rejects HttpError 500 code USAGE_LEDGER_CONFLICT (khong chon ben nao).

Pricing pass COST-02 (4) — 16. 2 events gpt-4o + tier 2.5/10 USD-M → pricing {2,0,22500} khop calculateOperationCost goi truc tiep. 17. model thieu tier + event pages=3 thieu page-rate → {1,2,7500}: unpriced KHONG im lang thanh 0 tien (docs: unpriced ≠ measured-zero). 18. duplicate delivery gia 1 LAN (dedup Map truoc pricing — pre-dedup se double-bill). 19. tier providerless + event provider openai → unpriced: nang Δ-D7a cua contract xuong service layer, khong tu mo rong khop.

### 5.4 Δ-DEVIATION (de coordinator adjudicate)

- **Δ-D24 — calculateTieredCost khong ton tai**: packet goi ten ham @du/contracts la calculateTieredCost; grep contracts src = 0 khop; ham that la calculateOperationCost (cycle 2). Lane dung ten THAT + resolvePricingTier gop thanh pricing pass. Dao nguoc neu muon alias: 1 dong export.
- **Δ-D25 — getUsageSummary DOI HANH VI tren du lieu hong (co y, fail-closed)**: du lieu hop le (int ≥0, safe) → so khong doi gi (test 1 toStrictEqual ca response). Stored row co float/am/vuot MAX_SAFE (chi sinh duoc qua ghi truc tiep DB — ingest() da validate int khi viet) → legacy CONG NOI NUOC (floating += khong tran); nay → HttpError 503. Chon fail-closed theo money-law; nguoc lai = chap float lang trong tong tien.
- **Δ-D26 — seam wire-vs-ledger duoc bao thuc, khong lat duoc**: DB hom nay CHUA CO payload nao IS UsageLedgerEvent (thieu 13 field — test 10 liet ke trang thai). reconcileUsageRows tren data that hom nay = zero summary + toan bo rejectedRows; aggregateUsageEvents chi tong thuc su khi producer wiring (packet COST-01 persistence, van mo) ghi ledger rows. Lane TU CHOI dung gia tri dinh de no chay. Ly do packet khong the claim live-verified.
- **Δ-D27 — khong mo them HTTP surface**: server.ts khong doi; getReconciliationSummary + budget options hien chi dung o service layer (route + quyen thuoc packet ADMIN/UI). Khong options → getUsageSummary byte-identical → moi consumer cu an toan (68 suite lane khac xanh la chung minh).
- **Δ-D28 — doc ledger theo tenant KHONG time-bound trong SQL**: window la cua filter contract (timeField rule cycle 3) — SQL pre-filter received_at se cat nham lech cho view occurredAt; tenant lon → doc nhieu dong vao memory. Chan page/cursor thuoc phia service COST-03 (packet rieng); lane khong tu them LIMIT vi se im lang cat tong — sai doi soat.
- **Δ-D29 — pricing pass ke thua Δ-D7a cua contract**: query provider= (ledger event luon co provider) khong khop tier providerless → dem unpriced (test 19 pin). Neu chinh sach gia muon global-tier fallback → doi 1 nhanh trong resolvePricingTier (cycle 2 da ghi san kha nang dao nguoc), khong o day.
- **Δ-D30 — [SKIP-QUALIFIED] o lenh packet step 2**: pnpm --filter @du/orchestrator test -- tests/usage-summary.test.ts offline tra Exit Code: 0 nhung 9 SKIPPED (DU_LIVE_INFRA gate; file W39-C khong thuoc lane). Day KHONG phai nghiem thu hanh vi tren DB — offline chi chung minh file con COMPILE + gate giu nguyen (khong co DB window nao bi mo cham). Nghi thu that cua 5 usage-summary live test can Tester giu DB window theo CLAIM/RELEASE; test 1 offline da pin DUNG fixture cua live-suite de land do sau nay khop deterministic.

### 5.5 Vi pham rang buoc?

Khong: OFFLINE ONLY — fake Db (plain object), khong createApp/listen, khong ket noi PG/Redis/S3 (suite moi khong import server.ts); lenh packet live-gated chi chay den muc tu-skip (Δ-D30). Khong git add/commit/push. Footprint lane: usage.ts (thuoc directory ?? san co tu truoc — lane khong commit) + test MOI usage-contracts-integration-offline.test.ts ??; packages/contracts KHONG bi cham trong cycle nay (17/385 x3); server.ts khong cham; 46 file test ?? khac cua lane khac nguyen hien trang.

### 5.6 Trang thai

**COST-05 (tich hop contracts → UsageService): hoan thanh offline — [PASS] bang chung x3 + 1 muc [SKIP-QUALIFIED] (live usage-summary, Δ-D30).** Muc do theo AGENTS.md: [IMPLEMENTED] cho duong ledger; duong wire van tra dang W39-C (zero-drift, hardening BigInt). Mo cua coordinator: Δ-D24..Δ-D30 (dac biet Δ-D26 producer wiring + Δ-D28 bounded read); Δ-D1..D23 van mo.

---

- 1 — W-COST-SCHEMA-LEDGER-1: usage-metrics.ts + ledger event + view models + 23 test; x3 exit 0 (contracts 14/260, obs 22; build; lint) — **Muc 1.**
- 2 — W-COST02-PRICING-MODEL-1: pricing.ts (tier int micro-USD + table/overlap/resolver + USD boundary parser + exact engine) + 24 test; x3 exit 0 (contracts 15/307, obs 22; build; lint) — **Muc 2.**
- 3 — W-COST03-RECONCILIATION-1: usage-reconciliation.ts (filter [from,to) instant + summary 5 int + aggregate BigInt + eventId dedup/conflict + MAX_SAFE guard) + 26 test; x3 exit 0 (contracts 16/333, obs 22; build; lint) — **Muc 3.**
- 4 — W-COST04-BUDGET-ALERT-1: usage-budget.ts (BudgetConfig strict + evaluateBudgetStatus BigInt floor/max-dim + reservation cong tran + RangeError guard) + 30 test + Δ-D22 fix UsageSummarySchema + index export; x3 exit 0 (contracts 17/385, obs 22; build; lint) — **Muc 4.**
- 5 — W-COST05-SERVICE-RECON-1: usage.ts tich hop (BigInt money-law + projectLedgerEvent + reconcileUsageRows qua aggregateUsageEvents + evaluateBudgetStatus option + pricing pass dedup-safe) + 19 test offline fake-Db; x3 exit 0 (lint/new19/br12/PKTC 9-skip/contracts 385) + full orch 68/17skip supplementary — **Muc 5.**
