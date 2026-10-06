# RFX-CRYPTO — RFX-08 + RFX-16 (crypto-storage-facade: bound collect + design note)

## RESUME POINT

- **Lane:** Qwen (RFX-CRYPTO), reassign tu lane `c448` (bi prompt-block).
- **Packet:** `du-rework/tasks/ORCH-REVIEW-FIXES-2026-10-02.md` muc **RFX-08** (P0 availability/DoS) + **RFX-16** (P3 design note).
- **Dispatch:** 2026-10-02T23:27:25+07:00 (coordinator command-code). Ghi receipt luc 2026-10-03T00:13:44+07:00.
- **File lease:** chi `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts` + focused tests cua no. **Da tuan thu**: khong sua file khac, khong commit, khong tick gate.
- **Receipt path:** dispatch packet ghi `codex-rfx-crypto-collect-2026-10-02.md`; coordinator yeu cau ghi `qwen-rfx-crypto-2026-10-02.md` — **ghi theo chi dao moi nhat**, khong tao file trung.
- **Trang thai:** IMPLEMENTED, offline verified (3 lan exit 0), **chua ACCEPTED**; live S3/Vault/PG evidence van mo.

---

## 1 — CYCLE 1: bound plaintext cho streaming decrypt (RFX-08) + design rationale (RFX-16)

### Sua packet truoc khi code (doc lai source, khong tin file:line cua packet)

Packet ghi `collectStream` nam trong `crypto-storage-facade.ts` (~line 254-263). **Khong dung.** Doc source hien tai (861 dong) thi:

- `collectStream` **khong ton tai** trong facade. No o `src/modules/encryption/artifact-read-decrypt.ts:254-264` (ham private, khong bound), duoc goi o `:237` cho nhanh chunked — **ngoai file lease**.
- Line 254-263 cua packet khop dung file do, nen packet gop nham hai file.
- `decryptChunkGenerator` co that, pre-patch o `:790` (packet ghi 795-810, gan dung).

He qua: phan sua **trong lease** la bound o phia facade (guard + option + default). `collectStream` phia caller giu nguyen — no **dung som** vi stream throw, nen peak = bound + 1 chunk. Ghi ro o Δ1.

### Thay doi (line theo file sau patch)

| Line | Noi dung |
| --- | --- |
| `:24` | `export const CRYPTO_STORAGE_MAX_DECRYPT_BYTES = 64 * 1024 * 1024;` + JSDoc `:15-23` noi ro no co y bang `MAX_DECRYPT_BYTES` (server.ts) va `maxBytes` ingress. |
| `:118-122` | Option moi `maxPlaintextBytes?: number` trong `CryptoStorageFacadeOptions`. |
| `:500` | Field `private readonly maxPlaintextBytes: number`. |
| `:510-520` | Constructor validate: safe integer, `1..CRYPTO_STORAGE_MAX_DECRYPT_BYTES`, sai thi `invalidInput(maxPlaintextBytes must be between 1 and ...)` — dung convention cua `maxChunks`. Default = 64 MiB. |
| `:695-702` | **Pre-check fail-closed** trong `decryptStream`: `manifest.totalSizeBytes > this.maxPlaintextBytes` → throw `SIZE_LIMIT` **dong bo**, ngay sau `validateManifest`, truoc Vault unwrap / MAC / bat ky plaintext byte nao. |
| `:706-710` | Truyen `self.maxPlaintextBytes` xuong generator. |
| `:831-853` | **RFX-16**: JSDoc design rationale o `decryptChunkGenerator`. **Khong doi thu tu lenh.** |
| `:856` | Generator nhan them tham so `maxPlaintextBytes`. |
| `:896-903` | **Runtime backstop**: ngay sau `totalSizeBytes += plaintext.length` va **truoc** `yield`, vuot nguong thi throw `SIZE_LIMIT`. Dat truoc `yield` vi caller giu moi chunk da nhan. |
| `:908-912` | `catch (error)` (truoc la `catch {}`): `SIZE_LIMIT` re-throw nguyen trang, khong bi relabel thanh `AUTHENTICATION_FAILED`. |

### RFX-16 — noi dung comment (packet: khong doi thu tu)

- Vi sao unwrap DEK **truoc** MAC-check la bat buoc: MAC key dan xuat tu DEK (`manifestMacKey` chay HKDF), nen khong the verify MAC khi chua co DEK; MAC-first se can mot key thu hai chung thuc chinh key ma envelope nay khong co.
- Vi sao `decrypt` single-shot lai unwrap **sau** AAD check: AAD cua no khong can key — do la ly do hai thu tu khac nhau (tranh doc nham la khong nhat quan).
- Pre-check nao da giam cost truoc khi toi generator: `validateManifest` chan field la, context AAD cua artifact khac, geometry sai, chunk sai thu tu / qua size, tong chunk lech `totalSizeBytes`, `totalChunks > maxChunks`; cong pre-check RFX-08 o `decryptStream`.
- Ghi chu rate-limit / backoff **phia Vault caller** (van 1 call/req) + giu "wrap sai" va "MAC sai" cung ra `AUTHENTICATION_FAILED` de error path khong lam oracle.

### Focused test (file moi, trong lease)

`services/orchestrator/tests/crypto-storage-plaintext-bound.test.ts` — **7 test**. Dinh nghia thang / thua tung test:

| Test | Thang khi | Thua khi |
| --- | --- | --- |
| defaults the bound to the delivery cap and rejects nonsensical overrides | `CRYPTO_STORAGE_MAX_DECRYPT_BYTES === 64 MiB`; `maxPlaintextBytes` trong {0, -1, 1.5, NaN, 64 MiB + 1} deu throw; `1` va `64 MiB` khong throw | bat ky gia tri nao lech, hoac constant khac 64 MiB |
| round-trips a chunked artifact that stays under the bound | artifact chunked 12 MiB → decrypt khop byte plaintext, `unwrapCalls === 1` | sai byte plaintext, hoac unwrap count khac 1 |
| keeps an artifact at exactly the bound readable | `maxPlaintextBytes = manifest.totalSizeBytes` → round-trip dung | tu choi o dung nguong, hoac tra sai byte |
| refuses an over-limit artifact before touching the body or the key provider | throw **dong bo**, `code === SIZE_LIMIT`, `unwrapCalls` **khong tang**, `bodyTouched === false` | phai doc body / unwrap Vault moi tu choi, hoac code khac SIZE_LIMIT |
| reports a size refusal as SIZE_LIMIT, not as an authentication failure | `code === SIZE_LIMIT` va khac `AUTHENTICATION_FAILED` | bi relabel thanh `AUTHENTICATION_FAILED` |
| stops emitting plaintext when the running total crosses the bound | `SIZE_LIMIT`, `0 < handed <= bound + 4 MiB`, `handed < totalSizeBytes` | collect tron artifact, hoac khong dung |
| bounds what a collecting reader retains (RSS evidence, not OOM) | `SIZE_LIMIT`, `retained <= bound + 4 MiB`, `retained < totalSizeBytes` | collector giu tron artifact |

Hai test cuoi lai thang seam private `decryptChunkGenerator` (qua `as unknown as`). **Ly do da ghi trong file test**: backstop runtime **khong reachable qua API cong khai** — pre-check da chan declared total, ma `validateManifest` pin kich thuoc tung chunk vao dung total do. Neu khong lai seam thi backstop chi la gia dinh. Day la ly do test, khong phai hack.

### Kiem chung

CWD cua moi lenh duoi day: `D:/Git/dugate/du-rework/services/orchestrator`.

| Lenh literal | Exit | Ket qua |
| --- | ---: | --- |
| `pnpm exec jest --runInBand --config jest.unit.config.cjs tests/crypto-storage-plaintext-bound.test.ts` | 0 | 1 suite / **7 passed** (5.431 s) |
| `pnpm exec jest --runInBand --config jest.unit.config.cjs tests/crypto-storage-facade.test.ts tests/crypto-storage-plaintext-bound.test.ts tests/artifact-read-decrypt-offline.test.ts tests/artifact-read-download-route.test.ts tests/public-upload-encryption-gateway.test.ts tests/encryption-boot-options.test.ts tests/delivery-encryption.test.ts tests/runtime-encryption-metadata.test.ts tests/rv0104-live-encryption.test.ts` — chay **3 lan lien tiep** | 0 / 0 / 0 | moi lan: `Test Suites: 9 passed, 9 total` + `Tests: 356 passed, 356 total` |
| `pnpm exec tsc --noEmit -p tsconfig.json` | 0 | khong in gi (typecheck orchestrator) |
| `pnpm exec jest --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | 0 | 11/11 (xem Δ6 — can cho attribution) |

Suite nao nam trong 9 suite: moi suite dung facade. `rv0104-live-encryption.test.ts` tu **SKIP** voi dong log `SKIP rv0104: live MinIO/Vault not reachable` nen **skip khac pass**, khong tinh la live evidence.

Raw output lan chay cuoi (3 lan):

```text
Test Suites: 9 passed, 9 total
Tests:       356 passed, 356 total
```

`tsc --noEmit -p tsconfig.json`: stdout/stderr rong, exit code 0 (cwd nhu tren). `tsconfig.json` chi `include: ["src/**/*.ts"]`, `exclude: ["tests"]` nen test duoc typecheck boi ts-jest (no da bat 2 loi type trong draft cua toi: `manifest` la Promise, va typo ten bien).

### Do RSS co tran — cach do va gioi han

Khong assert RSS trong jest (heap cua jest worker bi compiler + collector dung chung, tang/giam khong quy duoc cho vong lap nay). Do bang **tien trinh Node rieng**: compile facade ra `.qwen-tmp/rfx08-js` roi chay probe, moi mode mot tien trinh, `global.gc()` truoc baseline, lay peak sau **moi** chunk duoc collect, bao peak tru baseline. Collector trong probe giu **moi** chunk y het `collectStream`.

| Lenh literal (cwd `D:/Git/dugate/.qwen-tmp`) | Output |
| --- | --- |
| `node --expose-gc rfx08-rss-probe.js bounded 48 16` | `mode=bounded artifact=50331648 bound=16777216 retained=16777216 chunks=4 peakRssDelta=42020864 code=SIZE_LIMIT` |
| `node --expose-gc rfx08-rss-probe.js unbounded 48` | `mode=unbounded artifact=50331648 bound=67108864 retained=50331648 chunks=6 peakRssDelta=121864192 code=none` |
| `node --expose-gc rfx08-rss-probe.js bounded 128 16` | `artifact=134217728 bound=16777216 retained=16777216 chunks=4 peakRssDelta=42115072 code=SIZE_LIMIT` |
| `node --expose-gc rfx08-rss-probe.js unbounded 128` (facade default, tuc 64 MiB) | `artifact=134217728 bound=67108864 retained=0 chunks=0 peakRssDelta=53248 code=SIZE_LIMIT` |

Doc so: cung artifact 48 MiB — co bound 16 MiB thi collector giu **16 MiB** va dung voi `SIZE_LIMIT`; khong bound thi giu tron **48 MiB**. Voi artifact 128 MiB, facade default tu choi **ngay** (retained=0, RSS +52 KiB) vi pre-check chan truoc khi doc body.

**Gioi han phai noi ro:** day la artifact 48/128 MiB, **khong phai** 8 GiB; `peakRssDelta` co slack cua allocator (xap xi 2.5 lan so byte giu lai) nen la so do bang chung co tran, khong phai so chuan de so sanh giua may. So **deterministic** de reviewer tin la `retained` (byte thuc su bi giu).

### Sai sot cua chinh toi trong cycle (ghi lai de khong bi hieu nham la defect san pham)

1. Fixture deadlock: `await manifest` **truoc** khi drain `ciphertext` → manifest chi resolve sau khi stream xong nen 6 test timeout lan dau. Sua: drain body roi `await manifest`.
2. `toEqual` tren Buffer 12 MiB mat 35 s (deep equality cua jest). Doi sang `.equals()`.
3. `expect(peakRss >= baselineRss)` flaky (RSS co the **giam** khi GC) — da xoa han khoi test; RSS chi duoc assert o probe tien trinh rieng.
4. Lan dau chay 9 suite: `public-upload-encryption-gateway.test.ts` **3 fail** (row.token). Khong phai cua toi — xem Δ6.

### Δ-DEVIATION (de coordinator adjudicate)

- **Δ1 — `collectStream` phia caller van khong bound.** `artifact-read-decrypt.ts:254-264` ngoai lease nen khong sua. Hom nay no **khong the OOM** (stream dung voi `SIZE_LIMIT` o bound + 1 chunk), nhung van la code khong bound. Neu muon bound tai cho collect thi can packet rieng cho file do.
- **Δ2 — `SIZE_LIMIT` ra ngoai la 503 voi message sai.** `mapCryptoError` (`artifact-read-decrypt.ts:104-117`) map **moi** `CryptoStorageError` thanh `503 STORAGE_FAILURE / encrypted artifact could not be authenticated`, ke ca size refusal. Fail-closed thi dung, nhung message khien operator di tim van de key khong ton tai. Map rieng `SIZE_LIMIT` → 413 nam ngoai lease.
- **Δ3 — wiring nguong tu server.ts con thieu (dung nhu packet canh bao).** Khong call site nao truyen `maxPlaintextBytes`; `MAX_DECRYPT_BYTES` o `server.ts:158` la const private. Hom nay **nhat quan** vi default cua facade = 64 MiB = dung con so do, va ciphertext fetch da bi `readStreamBounded` chan o 64 MiB (`server.ts:207`). Neu ai do doi `ctx.config.maxBlobBytes` (`server.ts:2106`) thi bound cua facade **khong** di theo → can owner cua `server.ts` truyen xuong.
- **Δ4 — muc do dang khai thac thuc te thap hon packet mo ta.** Ca hai call site (`server.ts:1561`, `:2087`) di qua `artifactDecryptDeps` dung tu `s3StoredObjectReader` (`server.ts:562-564`), ma reader do da bound 64 MiB nen artifact >64 MiB fail **o tang fetch ciphertext** voi 413 `TOO_LARGE` truoc khi toi collect. Guard cua facade la **defense-in-depth**: no dong lo hong cho moi reader khac, future local-disk reader, hoac caller truyen `ciphertext` trong memory. Khong nen bao cao la da chan mot OOM dang khai thac ngay hom nay.
- **Δ5 — duong single-shot khong can sua.** `decrypt` (`:544`) da bound `CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES` (5 MiB) tu truoc. RFX-08 chi la chunk path.
- **Δ6 — 3 fail giua chung thuoc lane RFX-04/05/06, khong phai cua toi.** `git status` luc do cho thay `upload-encryption-gateway.ts` **va** `tests/public-upload-encryption-gateway.test.ts` deu dang modified (diff cua ho bo `SET token=$4` va doi expectation sang `not.toBe`, con sot 3 cho `toBe`). A/B: (a) chay suite do voi facade **ban goc** → 11/11 pass; (b) chay lai cung suite voi facade **da va cua toi** → 11/11 pass. Hai trang thai deu xanh voi patch cua toi nen 3 fail la trang thai sua do cua ho. Canh bao cho reviewer: **A/B phai chay cung thoi diem**, lech thoi diem thi ket luan attribution bi nhieu ( dung viec nay da xay ra voi toi).
- **Δ7 — live evidence van mo.** Quy tac chung cua packet yeu cau live S3/Vault/PG cho packet crypto. Lane chi verify offline (khong mo cua so DB). Can Tester chay live window: artifact >64 MiB tren blob GET (worker route + download route) de xac nhan 413/503 ro rang, va artifact <=64 MiB van serve dung.

### Pham vi diff

```text
 M du-rework/services/orchestrator/src/modules/encryption/crypto-storage-facade.ts   (+77 / -2)
?? du-rework/services/orchestrator/tests/crypto-storage-plaintext-bound.test.ts       (moi)
```

Khong file nao khac bi toi cham (cac `M` con lai trong `services/orchestrator` la cua lane khac, da hien dien tu truoc va khong lien quan). Khong commit, khong push, khong tick gate, khong nham `nocobase-10`.

- 1 — RFX-08 bound plaintext (facade option `maxPlaintextBytes` + pre-check + runtime backstop) va RFX-16 design rationale; 7 focused test moi; 9 suite x3 exit 0 (356 test), tsc exit 0; RSS probe tien trinh rieng; Δ1–Δ7 mo. — Muc 1.

Trang thai: **IMPLEMENTED / VERIFIED OFFLINE (3 lan exit 0); chua ACCEPTED — live evidence + review doc lap con mo.**