# Verify độc lập (DSH2) — hai suite Connectors: state honesty + fixtures — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY** trên `orchestrator/apps/admin-web/tests/connectors-state-honesty.test.mjs`, `tests/connectors-fixtures.test.mjs` và các module sản phẩm mà chúng nạp (`features/connectors/{state.ts, curl-import.ts, connectors-screen.tsx}`).
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test **offline**; **KHÔNG** sửa source/test/config/docs; **KHÔNG** `git add`/commit/push; **KHÔNG** tick gate; **KHÔNG** DB/Redis/mạng ngoài.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (temp unzip, đúng `engines`).
**Raw:** `coordination/reports/raw/verify-aweb-connectors-suites-2026-10-10/DSH2/` — `01-connectors-state-honesty.log`, `01-connectors-fixtures.log`, `02-both.log`, `03-dsh2-probe.log`, `04-dsh2-probe.cjs`, `SHA256SUMS.txt`.
**Receipt được kiểm:** `receipt-aweb-connectors-test-2026-10-10.md` · `receipt-aweb-connectors-fixtures-2026-10-10.md`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| `connectors-state-honesty.test.mjs` | **6/6 PASS, exit 0** — `tests 6 · suites 1 · pass 6 · fail 0 · skipped 0 · todo 0` (khớp receipt) |
| `connectors-fixtures.test.mjs` | **2/2 PASS, exit 0** — `tests 2 · suites 1 · pass 2 · fail 0 · skipped 0 · todo 0` (khớp receipt) |
| Chạy gộp hai suite | **8/8 PASS**, exit 0, `suites 2` |
| Assertion có load-bearing? | **CÓ** — honesty nạp **module sản phẩm thật** qua ESM (`data:` URL + rewrite import tương đối) rồi gọi hàm export thật; fixtures **trích + thực thi** khai báo thật với **guard cho cả hàm và hằng**, có guard diagnostics |
| Screen-wiring regex | **KHỚP CODE THẬT** — tôi đối chiếu 6/11 regex quan trọng nhất vào đúng dòng (`connectors-screen.tsx:155, 156, 258, 427, 676, 803`) |
| Claim '0 ký tự nháy kép' của receipt | **ĐÚNG** — đếm trên cả hai file receipt: 0 |
| Sản phẩm có bị lane khác sửa không? | **KHÔNG** — `state.ts`, `curl-import.ts`, `connectors-screen.tsx` đều **tracked & sạch** (`git status` rỗng) ⇒ hai suite đang kiểm code ổn định, không có drift |
| Probe độc lập của tôi (input riêng) | **7/7 PASS**, exit 0 |

**Một dòng cho coordinator:** cả hai suite Connectors **đạt verify độc lập** — 6/6 + 2/2 exit 0, assertion thực thi code sản phẩm thật (không so chuỗi), screen-wiring khớp đúng dòng, probe độc lập 7/7 với input của tôi; giới hạn duy nhất vẫn là **không có browser/Playwright**.

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd `apps/admin-web`) | Exit | Literal |
|---|---|---:|---|
| 1 | `node --test tests/connectors-state-honesty.test.mjs` | **0** | `✔ Connectors state honesty` · `ℹ tests 6` · `ℹ pass 6` · `ℹ fail 0` · `skipped 0` · `todo 0` |
| 2 | `node --test tests/connectors-fixtures.test.mjs` | **0** | `✔ connector read and config summary fixtures` · `ℹ tests 2` · `ℹ pass 2` · `ℹ fail 0` |
| 3 | `node --test tests/connectors-state-honesty.test.mjs tests/connectors-fixtures.test.mjs` | **0** | `ℹ tests 8` · `ℹ suites 2` · `ℹ pass 8` · `ℹ fail 0` |
| 4 | probe độc lập DSH2 (`04-dsh2-probe.cjs`) | **0** | `PROBE_RESULT 7/7 checks passed` |

Artifact:

| File | sha256 | mtime | lines | git |
|---|---|---|---|---|
| `tests/connectors-state-honesty.test.mjs` | `c64c477fb6fca29dd34986761bb50cd6f92508e403b40201fed31bc87d49ef41` | 23:43:40 | 232 | `??` |
| `tests/connectors-fixtures.test.mjs` | `41d026ebc3f19c508aac12f8fb2faa43e5fe8968eb7f4bed90844cc6106eaf59` | 23:43:21 | 156 | `??` |
| `src/features/connectors/state.ts` | `7a9006f2a6aa58e7ada1a992a96d7eb8f01f5ea0f2b878d4fda5e9240a7fc3ae` | 10-08 02:45:48 | 379 | **sạch** |
| `src/features/connectors/curl-import.ts` | `2a97245de0b6f5edde052c10148a9904f8e46b2387c09b7aafde6ce88e25c830` | 10-07 04:30:17 | 593 | **sạch** |
| `src/features/connectors/connectors-screen.tsx` | `7c53f008f554422e3216929e64cbfcea2080646fd338770108ed9320b34d606b` | 10-09 01:07:51 | 996 | **sạch** |

---

## 2. Đối chiếu receipt `connectors-test` (state honesty)

| # | Claim | Verdict | Bằng chứng |
|---|---|---|---|
| 1 | Suite tại `tests/connectors-state-honesty.test.mjs`, lease đúng file test | **ĐÚNG** | 232 dòng, `??`, không import dịch vụ ngoài |
| 2 | Phủ **capability parsing** + **fail-closed gating** khi quảng cáo thiếu/không đọc được | **ĐÚNG** | test `:64-85`: `parseConnectorCapabilities(null)`, thiếu `credentialWorkflow`, có key lạ → `null`; `connectorActionGating(null)` → **cả 6 cờ false** + reason `/advertisement is unavailable/` |
| 3 | Phủ **cờ độc lập** management / test / credential-workflow | **ĐÚNG** | test `:87-121`: management bật nhưng test/credential tắt → chỉ 4 cờ quản trị; management tắt nhưng credential+test bật → chỉ `test` + `rotate`; reason nêu `/management:false/` |
| 4 | Config summary chỉ lộ **keys đã sort** + **tên header**, không lộ giá trị | **ĐÚNG** | test `:123-151`: `keys` sorted, `headerNames: ['X-Trace-Id']`, `redactedHeaderNames: ['Authorization','X-Api-Key']`, và 5 sentinel (gồm host `private.example.test`) **không** xuất hiện trong JSON |
| 5 | Parse curl mẫu, **mask secret trong preview**, upsert config **không** chứa secret/local path; bearer chỉ nằm ở draft in-memory | **ĐÚNG** | test `:153-182` (preview `****9876`, header secret `****5432` + `valueChars`, form secret, file `@customer-file.pdf`; JSON preview không chứa 4 giá trị nhạy cảm, `trace-17` cũng không) và `:184-217` (`connectorConfigFromDraft` → `secretPresent: true`, `redactedHeaderNames`, `secretFormFieldNames`, `fileFormFieldNames`; payload upsert không chứa bearer/header/form/path; `plan.params.connectorId` đã trim) |
| 6 | Screen-wiring offline: các gate + helper an toàn **được dùng** bởi control của màn Connectors | **ĐÚNG** | test `:219-231` (11 regex); tôi đối chiếu 6 regex quan trọng vào đúng dòng thật: `connectors-screen.tsx:155` (`caps`), `:156` (`gating`), `:676` (`disabled={!gating.test || busy}`), `:258` (`upsertPlan`), `:427` và `:803` (`summarizeConnectorConfig`) |
| 7 | `node --test …` PASS, 6 test, 1 suite, 0 fail, exit 0 | **ĐÚNG** | lệnh #1 |
| 8 | Receipt tự quét 0 nháy kép | **ĐÚNG** | đếm trên file receipt: 0 |
| 9 | Không git add/commit/push | **ĐÚNG** | file vẫn `??` |

**Kỹ thuật đáng ghi nhận:** suite không copy code — nó transpile `state.ts` (ESNext), **rewrite import tương đối `./curl-import` thành `file://` tuyệt đối** (có `assert.notEqual` để bắt buộc rewrite xảy ra), nhúng vào `data:` URL rồi `import()` ⇒ **module sản phẩm thật** được nạp, và `parseCurlImport`/`summarizeCurlImport` được import trực tiếp từ `.ts` (Node type-stripping).

---

## 3. Đối chiếu receipt `connectors-fixtures`

| # | Claim | Verdict | Bằng chứng |
|---|---|---|---|
| 1 | Suite fixture tại `tests/connectors-fixtures.test.mjs` | **ĐÚNG** | 156 dòng, `??` |
| 2 | **Trích và thực thi** khai báo reader + config summarizer của sản phẩm | **ĐÚNG** | `extractDeclarations` (`:6-33`) + `loadHelpers` (`:35-50`); có **2 guard**: `remainingFunctions` và `remainingVariables` phải rỗng; thêm guard diagnostics |
| 3 | Fixture reader: row hỏng **được đếm là skipped**, row hợp lệ **giữ nguyên thứ tự** | **ĐÚNG** | test `:82-122`: `{ items: [validActive, null, malformedRevision, unexpectedField, validPending] }` → `{ items: [validActive, validPending], skipped: 3 }` và hai row hỏng **không** lọt vào `items` |
| 4 | Fixture config: giữ **top-level keys + tên header**, bỏ **giá trị** của cả header bí mật **lẫn** header thường | **ĐÚNG** | test `:124-155`: `keys: ['apiToken','endpoint','headers']`, `headerNames: ['X-Workspace-Label']` (header thường: giữ **tên**, bỏ **giá trị**), `redactedHeaderNames: ['Authorization','X-Session-Token','X-Proxy-Secret']`; 5 sentinel + `ignored-header-value` đều **không** có trong JSON |
| 5 | `node --test …` PASS, 2 test, exit 0 | **ĐÚNG** | lệnh #2 |
| 6 | Không stage/commit/push | **ĐÚNG** | file vẫn `??` |

---

## 4. Probe độc lập — 7/7 (loader riêng, input riêng)

Tôi tự viết loader (transpile ESNext + rewrite import + `data:` URL) và dùng **input của mình**, không lặp lại fixture của hai suite:

| # | Kiểm | Kết quả |
|---|---|---|
| P1 | Capability: 1 quảng cáo hợp lệ nhận, **10 dạng hỏng** bị từ chối (`null`/`[]`/số/chuỗi/thiếu field/sai kiểu/`knownConnectorIds` không phải mảng/key lạ) | ok |
| P2 | Gating: `null` → cả 6 cờ false + reason; **4 tổ hợp** management × test × credentialWorkflow → đúng ma trận | ok |
| P3 | Summary: keys sorted; **3 header bị redact** (2 theo tên bí mật + 1 `[REDACTED]`); 5 sentinel không lộ; chịu được `headers: []` và `headers: 'nope'` | ok |
| P4 | Upsert plan: **3 nhánh lỗi** (`connectorId`/`adapter`/`credentialRef` rỗng → `{ok:false, missing}`), trim cả 3 trường, `mode: 'create'`, và 5 chuỗi nhạy cảm (bearer/header/form/local path/tên file) **không** có trong payload | ok |
| P5 | Curl preview với command của tôi: `****7788` cho auth, header bí mật `****9911` + `valueChars`, header thường `set (13 chars)`, form bí mật `****2233`, file chỉ `@mask-file.docx`; 5 chuỗi nhạy cảm không lộ | ok |
| P6 | Reader: `skipped = 3`, thứ tự `['c-1','c-4']` giữ nguyên | ok |
| P7 | Meta: cả hai suite **không** có skip/only/todo; honesty có guard rewrite-import + diagnostics; fixtures có guard **hàm + hằng** + diagnostics | ok |

---

## 5. GAP / open items

1. **Không có browser/Playwright** (đúng ràng buộc): phần **render** control/gate trong JSX chỉ được chứng minh bằng regex nguồn (đã đối chiếu vào đúng dòng), chưa bằng DOM thật.
2. **`buildConnectorUpsertParams` luôn `mode: 'create'`** (`state.ts:332`) — không có nhánh update trong revision hiện tại. Đây là **quan sát sản phẩm**, không phải vấn đề của hai suite; nếu platform cần update mode thì phải là packet khác.
3. **Kỹ thuật nạp module của suite honesty khá chặt nhưng giòn có kiểm soát:** nếu `state.ts` sau này thêm một import tương đối khác, regex rewrite chỉ phủ `./curl-import` ⇒ suite sẽ **đỏ to** (module resolution) chứ không im lặng bỏ qua — chấp nhận được, nhưng người refactor nên biết.
4. **Hai file test `??` untracked** ⇒ provenance bằng sha256 (§1). Ba file sản phẩm liên quan **tracked & sạch** nên không có drift trong lượt này.
5. **Không có assertion nào bị nới:** cả hai là file mới; suite honesty còn tự khẳng định việc rewrite import **đã xảy ra** (`assert.notEqual`) thay vì chỉ tin.

---

## 6. Xác nhận

- Chỉ **đọc** + chạy `node --test`/probe offline; **không** sửa source/test/config/docs; **không** `git add`/commit/push; **không** tick gate.
- File tôi tạo: receipt này + 5 file raw trong `coordination/reports/raw/verify-aweb-connectors-suites-2026-10-10/DSH2/` (kèm `SHA256SUMS.txt`). Probe chạy trong `%TEMP%`; không bind cổng, không mạng.
- Không DB/Redis, không claim DB window, không đọc `.env.live`.
- Ghi chú trung thực: probe của tôi **pass 7/7 ngay lượt đầu** (không có lần sửa kỳ vọng nào); mọi kết luận gắn sha256 tại §1.
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
