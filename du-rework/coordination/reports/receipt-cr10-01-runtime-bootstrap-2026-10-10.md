# CR10-01 - Docker runtime boot: thieu LDBA03 context provider

| Muc | Gia tri |
|---|---|
| Task ID | CR10-01 (P1) |
| Ngay | 2026-10-10 (Asia/Bangkok) |
| Repo scope | D:/Git/dugate/du-rework |
| Canonical plan | tasks/CODE-REVIEW-FOLLOWUP-2026-10-10.md muc 2 (CR10-01); coordination/PLAN-OPEN-2026-10-09.md muc 9.3 hang 1 |
| Lease | scripts/docker/build-runtime.cjs + packaging/boot tests. Main.ts/create-app.ts nam trong lease nhung KHONG doi - xem muc 3 |
| Owner lane | Qwen-5R (implement) |
| Trang thai | IMPLEMENTED + offline-verified [PASS]. CHUA ACCEPTED - image build/boot thuoc independent verifier |
| Receipt | coordination/reports/receipt-cr10-01-runtime-bootstrap-2026-10-10.md |

## 1. Loi ke chinh xac (bang chung tu working tree, khong tu tai lieu dieu phoi)

1. `services/orchestrator/src/main.ts:233` - `registerLdb03ContextProvider(process.env);` goi VO DIEU KIEN o entrypoint. Call nay la hunks cua MDB-01 dang `M` (uncommitted).
2. `services/orchestrator/src/app/bootstrap/create-app.ts:157` - mac dinh nap `resolve(__dirname, '../../../scripts/ldba-context-provider.cjs')`. Tu file compiled `dist/app/bootstrap/create-app.js` chay `..` xuong 3 = `<root>/scripts/ldba-context-provider.cjs`. Neu `require` loi, ham throw `refusing to boot: LDBA03 context provider module could not be loaded`.
3. `scripts/docker/build-runtime.cjs` - truoc sua dong ~96 de `files: ['dist', 'migrations']` cho TAT CA workspace manifest, roi `pnpm deploy`. Chi hai thuoc tinh do duoc pack.
4. `services/orchestrator/Dockerfile` - `COPY --from=orchestrator-build --chown=node:node /deploy/orchestrator ./` vao `WORKDIR /app`, CMD `node dist/main.js`.

Ket qua doan: image chua `/app/scripts/ldba-context-provider.cjs` vi `scripts/` khong nam trong `files` allowlist, nen **moi lan boot deu tu choi khoi dong**. Day la hien tuong chinh xac CR10-01 mo ta, xac minh duoc bang cach chay buoc registration tren layout image gia lap (xem §5, test 6 va 7).

Note ve path: packet ghi `scripts/docker/build-runtime.cjs`. Duong dan day sau repo la `du-rework/scripts/docker/build-runtime.cjs` - nam TREN `orchestrator/`, khong phai ben trong no. Da verify bang glob truoc khi doc.

## 2. Sua (Option A: ship provider vao runtime artifact)

Them vao `build-runtime.cjs`:

- bang `RUNTIME_EXTRA_FILES` mo ta moi artifact runtime ma mot service can nhung `files` allowlist khong the bieu dien;
- `copyRuntimeExtraFiles(service, packageDirectory, output)` chay SAU `pnpm deploy`, copy dung mot file vao `<output>/<service>/scripts/ldba-context-provider.cjs`. File nao thieu thi throw `Missing runtime artifact for <service>` - tich cuc tu choi tao image hong thay vi bo qua;
- goi `copyRuntimeExtraFiles` o cuoi `buildRuntime` cho moi service; cac service khac khong khai nao thi la no-op.

Vi du o image: `/deploy/orchestrator/scripts/ldba-context-provider.cjs` -> Dockerfile copy toan bo `/deploy/orchestrator` thanh `/app` -> file nam dung o vi tri ma `create-app.ts` resolve tu `dist/app/bootstrap`.

### Tai sao chon ship chu khong tach registration (Option B)

Two ly do, khong phai tien ich rieng toi:

1. **Giu hanh vi fail-closed cua MDB-01.** Provider hien tai la mot stub fail-closed (7 callback deu throw `CONTEXT_POLICY_REQUIRED`). Bo registration di se doi thanh `khong cai policy nao` thay vi `policy dang la stub`, va adapter se loi o khac, muot hon nhung ro rang hon. CR10-01 yeu cau khong regresion adapter flow da chon.
2. **Giam dien tich lease.** PLAN-OPEN §9.3 canh bao CR10-01 CHUNG `create-app.ts` + `main.ts` voi bat ky packet nao sau, va phai SEQUENCE. Option A sua duy nhat `build-runtime.cjs` (khong ai dang hai lease nay), nen khong tang rui ro second writer.

## 3. Khong sua nhung gi co san trong lease

- `main.ts` va `create-app.ts` da do `M` TRUOC khi toi nhan packet (git diff = 54 insertion toan la hunks MDB-01: import, 7 callback list, ham `registerLdb03ContextProvider`). Toi KHONG revert va KHONG sua chung. Toi doc het diff truoc khi dot giac vao.
- `scripts/ldba-03-production-adapter.cjs` cung nam trong `scripts/` va cung khong duoc ship. Nhung do la CLI migration doc lap (`ldba-03-production-adapter.cjs` doc `LDBA03_CONTEXT_MODULE` tu env hoac gap toan trong chinh no), khong phai boot dependency cua service. De ngoai scope, ghi lai o muc 6.

## 4. Dinh nghia WIN/LOSE tung test

File: `tests/deployment/cr10-01-runtime-bootstrap-provider.test.cjs` (7 test, `node:test`, offline, khong DB/Redis/S3).

| Test | WIN | LOSE |
|---|---|---|
| orchestrator khai provider la runtime artifact | `RUNTIME_EXTRA_FILES.orchestrator` ton tai va chua `scripts/ldba-context-provider.cjs` | khong khai la boot tu choi khoi dong |
| duong shipped chinh la duong ma compiled bootstrap resolve | file tai `<deploy>/scripts/...`; `resolve(dist/app/bootstrap, ../../..)` ra dung vi tri do | hai ben lech nhau la lai loi boot trong production |
| provider load duoc, du 7 callback | moi callback la function | thieu callback la MDB-01 khong bao gio tao duoc provider |
| provider thieu thi packaging loi to | `copyRuntimeExtraFiles` throw `Missing runtime artifact for orchestrator` | tich cuc bo qua = tao image hong ma khong ai biet |
| service khong khai thi khong co gi | `readdirSync(output)` rong | phat sinh thu muc tu dong |
| boot tren layout image (co provider) | `registerLdb03ContextProvider({})` tra ve provider; `env.LDBA03_CONTEXT_MODULE` = modulePath; modulePath nam TRONG imageRoot | throw `refusing to boot` |
| boot tren layout image (KHONG co provider) | throw `refusing to boot: LDBA03 context provider module could not be loaded` | long thot = loi ro rang khi cau hinh tuong minh khong hop le |

Hai test cuoi chay MODULE COMPILED THAT (`dist/app/bootstrap/create-app.js`) tren layout image gia lap, khong phai tinh toan duong dan. Vi vay chung chinh la loi san xuat dung nghia, khong suy luan.

## 5. Bang chung chay

CWD `D:/Git/dugate/du-rework`. Node v24.21.0. Moi lenh dung `&& ... || ...` de exit code la that (khong suy tu `%ERRORLEVEL%`, vi cmd.exe mo rong luc parse).

### 5.1 Dieu kien tien quyet

`dist` cua `services/orchestrator` dang cu (khong chua hunks MDB-01) nen khong dung duoc cho boot test. Da build lai:

    node node_modules/typescript/bin/tsc -p tsconfig.json   -> ORCH_BUILD=PASS (exit 0)

`dist/` la gitignored, khong lam bai tree.

### 5.2 RED - mutation tren ban test CUOI CUNG

Bo entry khoi bang `RUNTIME_EXTRA_FILES` (tam thoi), chay lai toan bo file test cuoi:

    node --test tests/deployment/cr10-01-runtime-bootstrap-provider.test.cjs   -> MUT_FINAL=FAIL

    tests 7 / pass 2 / fail 5

Bon test do co assertion that. Test boot (test 6) cung do, voi chinh trieu chung san xuat:

    Error: refusing to boot: LDBA03 context provider module could not be loaded
      at Object.registerLdb03ContextProvider (.../.cr10-01-image-sim/dist/app/bootstrap/create-app.js:114:15)

Hai test con lai xanh trong ca hai trang thai la dung thiet ke: no la hai negative control (service khong khai thi khong co gi; anh khong co provider van loi to).

### 5.3 GREEN - 3 lan lien tiep

    for %i in (1 2 3) do @(node --test tests/deployment/cr10-01-runtime-bootstrap-provider.test.cjs > %TEMP%/cr10-01-final-run%i.txt 2>&1 && echo RUN%i_EXIT=0 || echo RUN%i_EXIT!=0)

    RUN1_EXIT=0
    RUN2_EXIT=0
    RUN3_EXIT=0

Moi lan literal:

    tests 7
    pass 7
    fail 0

### 5.4 Regression

- **Docker packaging suite** (`node --test tests/deployment/docker.test.cjs`): `14 pass / 6 fail` VA truoc (baseline do truoc khi sua) VA sau khi sua - khong doi mot test nao. Bo 6 red do la pre-existing: `portable deployment preserves every locked version and importer` (pnpm-lock.yaml drift do lane khac dang chay) va 5 test compose model (`ORCHESTRATOR_PORT` khong con undefined). Khong phai do CR10-01, khong re-blame.
- **MDB-01** (`node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/mdb-01-composition-provider.test.ts`) -> MDB01=PASS. Bao dam acceptance: provider tuong minh khong ton tai van loi co kiem soat (`CONTEXT_MODULE_LOAD_FAILED`) va adapter flow da chon khong regresion.
- **Typecheck orchestrator** (`tsc --noEmit -p tsconfig.json`) -> ORCH_TSC=PASS (exit 0, khong output). Day cung la lenh `lint` cua package.

## 6. Lech va diem can coordinator biet

**Lech 1 - chua build image that, chua boot health.** Acceptance bullet 1/2 (build image, image boot, health tra ket qua that) KHONG duoc chung minh boi receipt nay. Ba ly do khong phai phep tien: (a) standing rules cua lane rang buoc offline, khong mo cua so DB; (b) dang co writer dong thoi song tren CUNG service package - `oauth2-client.ts` (CR10-03/04), `ldba-03-*.cjs`, `smoke.cjs` deu `M` luc toi doc file. Mot build do xanh/doi do se kho gan duoc co chu, va neu no do thi khong phai do toi; (c) acceptance giao ro image digest + boot log cho independent verifier. Lenh cho verifier:

    docker build --target orchestrator -t du-orchestrator:cr10-01-local -f du-rework/Dockerfile du-rework

    docker run --rm --entrypoint ls du-orchestrator:cr10-01-local /app/scripts/ldba-context-provider.cjs

    docker run --rm -e DATABASE_URL=... du-orchestrator:cr10-01-local node -e "require('./dist/app/bootstrap/create-app.js').registerLdb03ContextProvider({})"

Khoi docker da co cache (`du-orchestrator:candidate-*` 304-305MB ton tai), nen build co the nhanh.

**Lech 2 - provider dang UNTRACKED.** `scripts/ldba-context-provider.cjs` la file `??` (chua commit) cua MDB-01. `copyRuntimeExtraFiles` se throw `Missing runtime artifact` neu build tu mot checkout sach (image build chay `COPY orchestrator/services`, nen file phai ton tai trong tree). Nghia la: CR10-01 chi dong sau khi MDB-01 commit provider. Day la dieu kien phu thuoc that, khong phai chu ky chung. Toi khong the commit (le se khong cho phep).

**Lech 3 - `build-runtime.cjs` lam la tree host.** `buildRuntime()` viet `files: ['dist','migrations']` vao MOI workspace manifest va ghi de `pnpm-lock.yaml`, khong restore. Comment trong file noi repository lockfile khong bao gio duoc rewrite - dung voi build-container nhung SAI voi host. Vi vay toi KHONG goi `buildRuntime` tren host, chi test buoc copy runtime bang `copyRuntimeExtraFiles`. De nghi lane build/cicd sua comment hoac lam no bang thoi (ghi lai de khong ai goi tren host va lau liet `package.json`).

**Lech 4 - da rebuild dist.** `services/orchestrator/dist` duoc build lai boi vi ban hien tai thieu hunks MDB-01. Dist la gitignored, khong lam bai tree, nhung neu lane nao dang dung dist cu thi no se thay doi. Ghi de phong.

**Lech 5 - adapter CLI cung khong duoc ship.** `scripts/ldba-03-production-adapter.cjs` nam cung thu muc. Neu operator chay migration tu trong container thi se thieu. Khong phai boot dependency, khoi scope nay, can packet rieng neu muon.

## 7. Phan gioi va trang thai

File da doi (chi 2):

    du-rework/scripts/docker/build-runtime.cjs | 24 + (insert)
    du-rework/tests/deployment/cr10-01-runtime-bootstrap-provider.test.cjs | 147 dong (moi)

    build-runtime.cjs                          sha256 453a3a5f317327e1732973bf911f539fa76190bc7d9d2f392b3e73c72e749de8
    cr10-01-runtime-bootstrap-provider.test.cjs sha256 12bdca2bebc7dfbb96e0be066a3acd01607f39006ee8b49560dc9315ca1e1f64
    (file ship) scripts/ldba-context-provider.cjs  sha256 da85493bc05b1723b6024644accbc7cbae1884266d4aeb1183307e6a50d990aa

- KHONG `git add`, KHONG `git commit`, KHONG push. Khong mo cua so DB/Redis/S3.
- Khong revert hunk cua MDB-01 hay cua lane khac.
- Khong tick gate, khong cap nhat trang thai CR10-01 trong task/plan.
- Trang thai: IMPLEMENTED, offline-verified [PASS], chua ACCEPTED. Independent verifier can: (1) build image tu checkout co provider da commit, (2) chay boot + health, (3) ghi image digest + boot log.
