# Danh gia doc lap frontend Orchestrator - goc nhin nhan vien ho tro / quan tri he thong

| Muc | Gia tri |
|---|---|
| Nguoi danh gia | Qwen-B, vai tro support/ops operator (read-only survey) |
| Ngay | 2026-10-10 (Asia/Bangkok) |
| Scope | du-rework/orchestrator/apps/admin-web/src (71 file .ts/.tsx) |
| Phuong phap | doc truc tiep source + grep dem so lan xuat hien; moi ket luan deu co file:line |
| Rang buoc da tuan thu | KHONG sua code san pham, KHONG git add/commit/push. Chi tao file bao cao nay. |

## 1. Ban do hien trang (do tren cay, khong lay tu tai lieu)

Dieu huong that (`src/app-shell/app-shell.tsx:15-21`) - 13 man, 4 nhom:

| Nhom | Man |
|---|---|
| Workspace | Overview, Operations, Usage |
| Configuration | Businesses, Profiles, Connectors, Workflows |
| Administration | Security, Secrets, Identity, Settings |
| Resources | API Reference, Documentation, Bootstrap |

Route that (`src/router.tsx`) khop 1-1 voi nav. **Khong co man Audit rieng** - audit nam trong Overview duoi dang mot card.

Tenant: da chuyen thanh **global** (`lib/tenant-context.tsx`, `TenantProvider` + `GlobalTenantSelector` trong app-shell:131), luu vao `localStorage`. Profiles (`profiles-screen.tsx:88`) va Businesses (`businesses-screen.tsx:31`) deu dung `useTenant()`. Day la tin tot.

## 2. Nhung gi dang lam tot (danh gia khach quan - khong phai moi thu deu thieu)

1. **Operations la man manh nhat** (`operations-screen.tsx`, 842 dong): loc theo state, tenant, limit (20/50/100), `id contains`, khoang ngay UTC; bulk cancel; retry chi hien khi state cho phep; detail co correlation id, bang task voi `attempt/maxAttempts` + `errorCode`, bang artifact co Download. Guard phan quyen ro: `role === 'viewer'` chan cancel, `role !== 'admin'` chan retry.
2. **Shell health strip** (`app-shell.tsx:109-122`) hien DB / Redis / queueIntegrity / activeLeases / outboxBacklog, poll 30s (`HEALTH_POLL_INTERVAL_MS`), co nhan stale sau 60s. Voi ops day la tin hieu tot.
3. **State contract 5 trang thai** dung chung (`components/ui/state-panel.tsx`): loading / ready / empty / error / denied - nhat quan tren moi man, khong man nao tu che.
4. **Pagination keyset** + `cursor` o Operations; Usage co `From/To` + auto-refresh + nhan do tuoi du lieu (`DataAgeLabel`).
5. **Workflows da len that** (xem muc 3.1) - co list live, provision, retire, test execution.

## 3. Diem yeu - co bang chung do duoc

### 3.1 Bao cao 10-09 da cu 2/5 diem (canh bao ve quy trinh)

`coordination/reports/admin-portal-feature-analysis-2026-10-09.md` moi hon mot ngay nhung:

- **F1 (thieu tenant o Profiles/Businesses) - DA XONG theo cach khac.** Ca hai nay dung `useTenant()`; `TenantSelect` khong con duoc man nao dung (0 reference trong `features/`).
- **F4 (Workflows-disabled banner) - KHONG CON Y NGHIA.** Man nay gio goi `client.listWorkflows` (`workflows-screen.tsx:242`), `provisionWorkflow` (:285, :317), `retireWorkflow` (:344), `postAction('workflow.test')` (:381). Khong con la banner tinh.

⇒ Khuyen nghi: danh gia frontend phai **re-verify truoc khi lap ke hoach**, khong duoc ke thua ket luan cu.

### 3.2 D1 - Server tra `correlationId` va `errors[]`, frontend **parse roi vut**

Day la diem yeu nghiem trong nhat voi ho tro, vi **du lieu da co san o client**.

- `lib/api/types.ts:24-31`: `AdminApiProblem` co `correlationId?: string` va `errors?: { pointer, message }[]`.
- `lib/api/client.ts:551` **co parse** `correlationId` tu body loi.
- Nhung `components/ui/state-panel.tsx` (`ErrorState`, `DeniedState`) **khong co prop nao** cho correlationId, va `ProblemPane` (`overview-screen.tsx:780-801`) chi truyen `title`, `status`, `code`.
- `grep problem\.errors` trong `features/` = **0 hit**.

He qua: khi mot request 422/500, man hinh chi hien `code` (vi du `INVALID_INPUT`). Nhan vien ho tro **khong co correlation id de tra log**, va **khong thay `pointer` chi ra field sai** - dung hai thu can nhat de xu ly ticket.

### 3.3 D2 - Khong co state tren URL (khong the chia se / khong refresh duoc)

`grep 'useSearchParams|useLocation|URLSearchParams'` toan `src/` = **1 hit**, va hit do la `new URLSearchParams()` trong `client.ts:529` de dung query request - khong lien quan dieu huong.

He qua thuc te:
- Khong the gui dong nghiep mot link da loc san ("mo Operations, state=FAILED, tu ngay X").
- F5/refresh mat het bo loc; nut Back cua trinh duyet roi khoi man chu khong quay lai bo loc truoc.
- Tu mot audit event **khong the nhay** sang operation bi anh huong.

### 3.4 D3 - Dinh danh khong copy duoc (clipboard chi co o Workflows)

`grep navigator.clipboard` trong `src/`: chi trong `workflows-screen.tsx` (:271 copy digest, :871 copy JSON).

Trong Operations, `correlationId` duoc render la `<code>` tai `operations-screen.tsx:495` va operation id o bang - **khong co nut copy**. Thao tac dau tien cua ho tro (dan id vao log/ticket) hien phai **tu boi den bang chuot**.

### 3.5 D4 - Khong co export o bat ky man nao

`grep 'toCsv|.csv|text/csv|createObjectURL'` trong `features/` = **0 hit**.

Operations, Usage, Audit deu khong xuat duoc gi. Ho tro phai chup man hinh hoac copy tay tung dong khi can dinh kem ticket hoac phan tich ngoai.

### 3.6 D5 - Audit bi gop vao Overview, gioi han 50, loc khong du

- `overview-screen.tsx:297`: `auditQuery = { limit: '50' }` - **cung 50, khong paging**.
- Bo loc trong `AuditCard` chi co All / Errors / Warnings (:660-700) va loc **client-side tren 50 dong da tai** - khong phai loc server.
- Trong khi do backend **da tra du**: `features/overview/state.ts:22-36` - `AuditEventWire` co `actor`, `kind`, `severity`, `resourceId`, `occurredAt`, `tenantId`, va `AuditListPage` co ca `total` + `limit`.

He qua: cau hoi ho tro gap hang ngay - *"ai doi profile nay luc 14:03?"* - khong tra loi duoc tren UI. Phai xuong DB.

### 3.7 D6 - Operations khong tu lam moi; auto-refresh mac dinh TAT

- Operations **khong poll du lieu**: interval 1 giay tai `operations-screen.tsx:60` chi cap nhat `nowIso` de hien thoi gian troi qua, khong goi lai API.
- Auto-refresh co o Overview (`overview-screen.tsx:372`) va Usage (`usage-screen.tsx:110`) nhung **mac dinh Off** va khong cho chon chu ky.

Trong su co, nhan vien phai bam Refresh lien tuc. Va vi D2, moi lan bam la moi lan mat bo loc neu vo tinh dieu huong.

### 3.8 D7 - Tron ngon ngu trong cung mot thanh cong cu

`operations-screen.tsx` thanh cong cu loc dung ca hai ngon ngu: `Cancel selected` (dong 260), `Da chon: {selected.size}`, `Bo chon` (dong ~264-266). `workflows-screen.tsx` dung tieng Viet cho thong bao (`Da kich hoat thanh cong workflow mau...`, :290) trong khi phan con lai cua portal dung tieng Anh.

Voi ho tro, day khong phai chuyen my quan: script xu ly su co va anh chup man hinh gui cho khach se **khong nhat quan**, va nguoi moi phai hoc hai bo tu vung.

### 3.9 D8 - Dead code nho

`components/ui/tenant-select.tsx` export `TenantSelect` nhung **0 reference** trong toan bo `src/` (da bi `GlobalTenantSelector` thay the). Nen xoa hoac danh dau deprecated de nguoi sau khong tuong con dung duoc.

## 4. De xuat tinh nang (uu tien cho van hanh / ho tro)

Tat ca deu **khong can doi backend** tru khi ghi chu ro, vi du lieu da co san o client.

| # | Tinh nang | Giai quyet | Bang chung | Effort | Backend |
|---|---|---|---|---|---|
| F1 | Hien + copy `correlationId` va `errors[].pointer` o moi panel loi | Khong tra duoc log, khong biet field nao sai | §3.2 | S | Khong |
| F2 | Dua bo loc len URL (deep link) + `?id=` mo thang detail | Khong chia se duoc, refresh/Back mat bo loc, khong nhay tu audit | §3.3 | M | Khong |
| F3 | Audit thanh man rieng: loc actor/kind/severity/resource/thoi gian + paging | Khong tra loi duoc "ai doi gi luc nao" | §3.6 | M | Khong (BFF da nhan query) |
| F4 | Export CSV/JSON cho Operations, Usage, Audit | Khong dinh kem duoc bang chung, phai chup man hinh | §3.5 | S | Khong |
| F5 | Live mode cho Operations + dai dem trang thai | Phai bam Refresh lien tuc trong su co | §3.7 | S-M | Khong |
| F6 | Health strip thanh actionable (nguong, mau, drill-down) | Tin hieu tot nhung thu dong, khong dan toi dau | §2.2 | S-M | Khong |
| F7 | Thong nhat ngon ngu + microcopy loi co buoc tiep theo | Script/ anh chup khong nhat quan | §3.8 | S | Khong |

### F1 - Correlation ID va field-level errors (uu tien 1)

**Van de:** xem §3.2. Day la tinh nang re nhat va gia tri cao nhat cho ho tro.

**Giai phap:** them prop `correlationId?: string` va `issues?: { pointer, message }[]` vao `ErrorState`/`DeniedState`; `ProblemPane` truyen tiep tu `problem`; hien correlation id duoi dang `<code>` **kem nut copy**; voi `errors[]` hien danh sach `pointer -> message` (vi du `/callbackPolicy/auth/method`). Them nut copy canh operation id va correlation id o Operations.

**Gia tri:** nhan vien ho tro copy duoc id de tra log ngay, va voi 422 biet chinh xac field sai thay vi doan. Giam round-trip voi khach.

**Rui ro:** thap. Chi la hien thi them du lieu da parse. Luu y khong duoc lo gia tri secret - `errors[].message` tu server da duoc thiet ke an toan, nhung nen kiem lai truoc khi hien nguyen van.

### F2 - Deep link / URL state (uu tien 2)

**Van de:** xem §3.3.

**Giai phap:** dung `useSearchParams` cho bo loc cua Operations/Usage va cho Audit; them nut `Copy link`; cho phep `/operations?id=<opId>` tu mo detail; tu audit event them link sang operation. Giu `localStorage` cho tenant nhu hien tai (da tot).

**Gia tri:** chia se duoc hien truong su co bang mot link; refresh/Back khong mat ngu canh; dieu tra cheo Audit -> Operations tro thanh mot cu click.

**Rui ro:** trung binh - can chuan hoa ten tham so va tranh vong lap cap nhat state <-> URL. Nen lam cung luc voi F3 vi Audit cung can.

### F3 - Audit thanh man rieng (uu tien 3)

**Van de:** xem §3.6.

**Giai phap:** tach Audit khoi Overview thanh route `/audit` (them vao nhom Administration), voi: loc theo `actor`, `kind`, `severity`, `resourceId`, khoang thoi gian; paging dung `total` + `limit`; cot `occurredAt` (UTC) + `actor` + `resourceId` + `message`; moi dong co link toi resource lien quan.

**Gia tri:** tra loi duoc cau hoi ho tro gap hang ngay ma khong can DB; la bang chung phap ly khi can doi chieu.

**Rui ro:** thap-trung binh. Backend da tra du truong (`overview/state.ts:22-36`) va `client.listAudit(query)` da nhan query (`client.ts:325`) - can xac nhan BFF thuc su forward cac filter nay, neu chua thi phai mo mot packet backend rieng.

### F4 - Export CSV/JSON (uu tien 4)

**Van de:** xem §3.5.

**Giai phap:** nut `Export` o Operations / Usage / Audit, xuat dung **tap du lieu dang xem** (ton trong bo loc) kem header ghi ro bo loc + thoi diem + tenant, de bang chung khong bi hieu sai ngu canh. Xuat client-side bang `Blob` de khong doi backend.

**Gia tri:** dinh kem ticket, phan tich ngoai, doi chieu voi khach.

**Rui ro:** thap. Can luu y: chi xuat trang hien tai hay xuat toan bo ket qua khop bo loc - neu "toan bo" thi phai tai nhieu trang va canh bao khi lon.

### F5 - Live mode cho Operations (uu tien 5)

**Van de:** xem §3.7.

**Giai phap:** them auto-refresh cho Operations voi chu ky chon duoc (5/10/30s), mac dinh Off, giu nguyen bo loc khi refresh, va hien `DataAgeLabel` nhu Usage da co. Them dai dem theo trang thai (RUNNING / FAILED / CANCELLED / TIMED_OUT) va danh dau dong moi xuat hien.

**Gia tri:** theo doi su co lien tuc ma khong bam tay; phat hien nhanh dot loi moi.

**Rui ro:** thap. Phai dam bao khong refresh khi dang co thao tac (cancel/retry dang chay) de tranh ghi de trang thai.

### F6 - Health strip thanh actionable (uu tien 6)

**Van de:** strip hien tai chi doc chu (app-shell.tsx:109-122), khong co nguong/mau, va chi co mot link `Health details`.

**Giai phap:** them nguong (vi du outbox backlog > X thi canh bao), to mau theo muc do, va cho phep bam vao tung chi so de nhay sang man lien quan da loc san (outbox backlog -> Operations loc FAILED).

**Gia tri:** bien mot dai thong tin thu dong thanh diem vao triage.

**Rui ro:** thap. Nguong phai lay tu cau hinh, khong hard-code, neu khong se lech voi backend.

### F7 - Thong nhat ngon ngu va microcopy (uu tien 7)

**Van de:** xem §3.8.

**Giai phap:** chot mot ngon ngu cho toan portal (de xuat tieng Anh vi phan lon dang la tieng Anh va API/docs deu tieng Anh), sua cac chuoi tron lan; them dong "buoc tiep theo" cho cac ma loi thuong gap (403 -> kiem tra tenant dang chon; 422 -> xem `errors[].pointer`; 409 -> tai lai).

**Gia tri:** script ho tro va anh chup nhat quan; giam cau hoi "cai nay nghia la gi".

**Rui ro:** thap, nhung can mot lan ra soat toan bo chuoi - nen lam sau khi F1-F3 xong de tranh sua hai lan.

## 5. Thu tu de xuat va cach do thanh cong

1. **F1** (nho, gia tri cao, khong phu thuoc) - do bang: co correlation id trong panel loi o >= 3 man, va nut copy hoat dong.
2. **F2 + F3** cung dot (Audit can deep link) - do bang: mo lai link da loc cho ket qua giong nhau; Back/Forward giu bo loc.
3. **F4** - do bang: file xuat ra co header ghi bo loc + tenant + thoi diem.
4. **F5** - do bang: bat live mode 30s, bo loc khong doi, khong mat du lieu dang thao tac.
5. **F6, F7** - don dep va hoan thien.

## 6. Ranh gioi cua bao cao nay

- **Read-only.** Khong sua mot dong code san pham nao; khong `git add` / `commit` / `push`.
- Moi ket luan deu dua tren doc source o thoi diem 2026-10-10. Toi **khong** chay UI, khong chay browser, khong chay test - nen cac nhan dinh ve trai nghiem (vi du "phai bam Refresh lien tuc") la suy ra tu code, khong phai do tuong tac that.
- Rieng F3, toi chua kiem BFF co forward day du cac filter audit hay khong. Truoc khi lap ke hoach can xac nhan - neu BFF chua ho tro thi F3 can mot packet backend.
- Cac de xuat **khong** thay the quyet dinh cua product owner ve pham vi va uu tien.
