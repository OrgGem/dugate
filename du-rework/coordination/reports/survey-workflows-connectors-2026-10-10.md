# Khao sat man hinh con lai admin-web - chuan bi wave tiep theo cua PLAN-FRONTEND-ADMIN-WORKSPACE

| Muc | Gia tri |
|---|---|
| Nguoi khao sat | Qwen-B, doc-only survey |
| Ngay | 2026-10-10 (Asia/Bangkok) |
| Scope | du-rework/orchestrator/apps/admin-web/src/features/* (15 thu muc) + router + app-shell |
| Bo cuon phu thuoc | coordination/PLAN-FRONTEND-ADMIN-WORKSPACE-2026-10-10.md (doc lai, khong hinh) |
| Rang buoc | KHONG sua code san pham, KHONG git add/commit/push. Chi tao file bao cao nay. |

## 0. Nguyn tac: hinh lai, khong ke thua ket luan cu

Mot bao cao 10-09 da lech 2/5 sau mot ngay, va khi toi van khao sat P0-P5 dang chay dong thoi. Vi vay toi **khong ke thua** bang nhan dinh cua §9 trong plan; toi re-verify tung claim truoc khi ghi.

Ket qua: **khong ket luan nao cua plan bi lech** — nhung con 4 diem noi bat ma plan chua de cap, va 2 dieu kien thuan can cho wave tiep theo.

## 1. Doi chieu lai plan (da kiem lai, khong phai nho)

| Claim cua plan §9 | Verdict cua toi | Bang chung |
|---|---|---|
| AWEB-17 (workflow test honesty) DA XONG | **XAC NHAN** | `workflows-screen.tsx:425-484` - xem §2.1 |
| AWEB-18 (Audit) DA XONG | **XAC NHAN** | `router.tsx:43`, nav `app-shell.tsx:20` |
| AWEB-19 (Trace) DA XONG | **XAC NHAN** | `router.tsx:44`, nav `app-shell.tsx:16` |
| AWEB-21 (deep-link chua doc query) DANG MO | **XAC NHAN** | xem §5.2 |
| AWEB-16b (Overview metrics) con lai | **XAC NHAN** | `overview-metrics.ts:228` `const total = operations.length` |
| Worker telemetry dang gia | **DA SUA** | `operations-monitor-dashboard.tsx:501-524` dung heartbeat + `sampledAt` + trang thai rong that |
| Link `/api-keys` chet | **DA SUA** | grep `Link`/`href` toan features: khong con `/api-keys`; cac toi su deu khop router |

## 2. Workflows (1191 dong, 1 file) - kiem gia lap

### 2.1 AWEB-17 da dung, khong con bao thanh cong gia

Doan `handleExecuteTest` (`:423-486`) bay gi:

- **Nhanh simulation chi chay khi `testSource === 'simulation'`** (`:425`) - va `testSource` duoc dat thanh `backend` mo thang khi mo modal (`:413`, `openTestModal`). Nen khong co duong nao dua thanh cong gia len backend that.
- Nhanh simulation **noi ro minh la simulation**: `SIMULATED_SUCCESS` + message `was simulated locally; no backend request was sent.` (`:431-433`).
- Nhanh backend thanh cong dat `status: 'ACCEPTED'`, va **lay `operationId`/`stagesCompleted` tu response**, chi spread khi ton tai (`:456-467`) - khong tu che nua.
- Backend loi → `status: 'FAILED'` + `problem.code` + `httpStatus` (`:468-476`); ngoai le → `FAILED` + ma loi that (`:477-485`).
- `grep sim-op` toan features = **0 hit** → khong con id ao `sim-op-*`.
⇒ Cau hop dong cua AWEB-17 duoc thoa man tren doc code.

### 2.2 PRESET_SAMPLES khong phai la du lieu gia (trung thuc)

`PRESET_SAMPLES` (`:61-200`) la **danh muc mau de cai dat** (mot nut `provisionWorkflow`, `:326`), khong phai du lieu fake dang noi len trang duoc. Neu co, do la khong ro chu khong phai gian lan: khong co chuoi nao noi day la da co san.

**Diem nho can xet:** `simulatedStages: selectedWorkflow.stages ?? []` (`:435`) - `WorkflowCatalogItem.stages` la optional (`lib/api/types.ts:660`), nen neu backend khong tra `stages` thi ket qua simulation hien **danh sach stage rong**. Khong phai loi hang dau, nhung la mot muc ket qua rong giac ma operator co the hieu nham.

### 2.3 Ngon ngu lech - bay gio mo rong hon truoc

Man Workflows gan nhu toan tieng Viet (`:384`, `:393` `Da huy kich hoat...`, `:1042` `Dan JSON schema vao day...`, `confirm()` `:383`) trong khi 14 man con lai tieng Anh. Day khong phai chuyen my quan doi voi giua `operations-monitor-dashboard.tsx:507` tieng Viet va `:524` tieng Anh trong **cung mot card**.
## 3. Connectors (2094 dong, 4 file) - khong tim thay mock nao
Toi tim ky cho du lieu gia va duong chet. **Ket qua: sach.**
| Dau hieu gia lap tai phai tim | Thuc te |
|---|---|
| Danh sach connector mau | Khong - `client.listConnectors()` (`:113`), `listRows` lay tu server (`:278`) |
| Capabilities mau | Khong - `client.getConnectorCapabilities()` (`:136`) |
| Revision gia | Khong - `client.getConnectorRevision()` (`:161`) |
| Test gia | Khong - `client.testConnector(id, crypto.randomUUID())` (`:238`) |
| Goi y ID hard-code | Khong - `connectorIdSuggestions(caps, listRows)` (`:284`) tinh tu **capabilities + danh sach that** |
| Nut doi voi trang thai khong co | Khong - gating (`:155-156`) va `saveDisabled`/`saveTitle` (`:880-881`) |
| Trang thai nham la co du lieu | **Trung thuc, khong nham** - `:641` `...adapter/capabilities are placeholders, not connector truth`; `:899` `...nothing can be written from here - nothing is faked` |
**Hai diem dang luu y (khong phai loi):**
1. Connector ID da chuyen tu **input + datalist** sang `<select>` that tai `:506-508` (gợi ý `No connector IDs available`). Do la F2 cua bao cao 10-09 da thuc hien. Datlist con lai o `:533` la cho **so revision** - hop ly, vi co nhieu gia tri hop le.
2. `CURL_PLACEHOLDER` (`curl-import-preview.tsx:14`) la placeholder cua textarea cho phep dan curl - khong phai du lieu da luu.

## 4. Mot so man con lai - chi nhung diem anh huong toi wave tiep

| Man | Dong | Ket luan |
|---|---|---|
| audit (moi) | 444 | Khong co link toi tai nguyen lien quan - **khong duong chet**, nhung **khong co duong thoat** |
| trace (moi) | 638 | Co 2 link (`:264`, `:267`) toi `/operations?id=...` va `/audit?tenantId=...` - xem §5.2 |
| overview | 2284 | `overview-metrics.ts:228` van tinh tren bo nho cua trang da tai - **AWEB-16b con lai** |
| businesses | 412 | `listBusinesses({limit:'50'})` (`:47`) - co nhan pham vi, khong tim |
| settings | 240 | `SETTINGS_CATALOG` la **ban do disposition** (port/retire) cua khoa legacy; `settingsWriteReason` tra ly do tat that (`:66-70`) - khong ghi gia tri gia |
| security / identity | 204 / 615 | Honesty cao: `:151` `reload - nothing is faked here`, `:720` `404 ACTION_NOT_FOUND ... nothing is faked here` |
## 5. Duong chet va duong nua-chet
### 5.1 Khong con duong chet noi bo
Nav 16 muc (`app-shell.tsx:16-21`) doi chieu 1-1 voi 15 route + index + wildcard (`router.tsx:42-57`). Moi `Link`/`href` toi su deu khop route co thuc. Khong con `/api-keys`.
### 5.2 AWEB-21 van con (da doi chieu xac nhan)
`buildTraceLinks` (`trace/state.ts:366-373`) **xay ra** URL co query, nhung `grep useSearchParams|searchParams|location.search` toan `src/` chi co 3 hit: `client.ts:592` (dung cho request) va `trace/state.ts:367-368` (tu minh build URL). **Khong man hinh nao doc query.**
Nen hai link do se mo man dung nhung **bo qua het tham so** - doi vi tri hien thi tuong ung voi link, nhung khong loc. Day la loi cung hang AWEB-16b: trung thuc, nho, frontend-only.
**Phat hien moi:** `audit-screen.tsx` khong co bat ky `Link`/`href` nao. Nen dieu tra nguoc lai (tu su kien audit sang operation) khong co duong nao - chua phai duong chet, nhung la mat tich canh bang vi tri doi xung cua trace.
### 5.3 Math.random khong phai la du lieu gia
`identity-api.ts:227` va `secrets-screen.tsx:102` dung `Math.random` sinh **idempotency key** phia client. Do la su dung dung. Neu moi nhan ai do bao day la mock thi day la bang chung tra loi.
## 6. De xuat cho wave tiep theo (chua dispatch, cho quyet dinh)
Sap theo gia tri/cong; moi dieu deu co bang chung o tren.
| # | Dieu | Bang chung | Pham vi |
|---|---|---|---|
| **W-A** | AWEB-16b: chinh lai the Tong/success rate de khong dua tren 100 dong trang dau | `overview-metrics.ts:228` | frontend (plan noi `page.total` da co) |
| **W-B** | AWEB-21: Audit + Trace doc URL query; Trace link se loc duoc that | §5.2 | frontend |
| **W-C** | Audit co duong toi tai nguyen (doi xung voi Trace) | §4 audit | frontend |
| **W-D** | Workflow simulation: hien ro khi `stages` rong thay vi de trong | §2.2 | frontend |
| **W-E** | Thong nhat ngon ngu (nhat la giua Viet/Anh trong cung card) | §2.3, §3 | frontend |
**Khong de xuat** lai: AWEB-17/18/19/20 da xong (§1), thay the bang W-A..W-E. Neu ai nhan task va khong doc §1, se lam lai viec da xong.
## 7. Ranh gioi cua bao cao
- **Read-only.** 0 sua code san pham, 0 commit.
- Moi ket luan deu doc tu source tai 2026-10-10. Toi khong chay UI/browser va khong chay test; phan noi coi/thuc nghiem (vi du `testSource` mac dinh la `backend`) la suy ra tu code, khong phai tuong tac that.
- Cac dong nay dang di chuyen: P0-P5 dang lam viec tren `apps/admin-web`; neu doc lai, doi chieu lai file:line.
