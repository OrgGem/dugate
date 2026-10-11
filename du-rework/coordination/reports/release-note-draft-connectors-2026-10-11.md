# Draft release note - Admin Portal: man Connectors

| Muc | Gia tri |
|---|---|
| Trang thai | **DRAFT** - cho review doc, chua duyet, chua phat hanh |
| Ngay chot file:line | 2026-10-11 |
| Pham vi | `apps/admin-web` - man Connectors |
| Nguon kiem chung | `docs-connectors-screen-honest-audit-2026-10-10.md` (re-verify 2026-10-11) |

## 1. Tom tat

Man Connectors cho phep nhan vien van hanh xem danh sach connector, doc mot revision, va ghi thay doi (tao, kich hoat, tat, dung, thu hoi) khi deployment da tu quang ca nang luc do. Man co them cong dan curl de tao connector tu lenh mau.

## 2. Diem moi va hanh vi xac nhan

- **Doc du lieu that.** Danh sach connector, capabilities, revision va ket qua probe deu den tu API qua BFF; man khong hien hang mau hay so lieu gia lap.
- **Nut ghi chi bat khi backend chap thuan.** Man tu doc capabilities cua chinh deployment do. Neu khong doc duoc capabilities, **tat ca nut ghi tat** va hien ly do.
- **Trang thai khong co store duoc noi ro.** Khi backend khong compose store connector, man ghi ro rang adapter/capabilities chi la placeholder, khong phai connector thật.
- **Config chi hien ten khoa.** Gia tri header den voi `[REDACTED]`; phan tom tat config chi tra danh sach khoa + danh sach header bi che, khong tra gia tri.
- **Secret khong di trong payload ghi.** Header co ten la secret va form field bi rut ve **ten**; man chi hien co con secret hay khong.
- **Goi y connector ID lay tu backend.** Co danh sach chon (select) sinh tu danh sach management hoac tu `knownConnectorIds`; van co o nhap tay khi can.
- **Dong reader khong lam dep du lieu hong.** Dong khong khop schema duoc dem vao `skipped` va hien ra, khong bi loai bo am tham.
- **Cong dan curl co canh bao.** Tu choi command substitution, che secret trong preview, bao loi co ma.

## 3. Hanh vi can noi ro (khong phai loi)

- **Preview import giu 4 ky tu cuoi cua secret.** Secret dan vao duoc che thanh `****` cong 4 ky tu cuoi de doi chieu. Day la quy uoc xem truoc, khong phai su co; neu release note dung tu che, hay dung cau nay: che secret trong preview import, giu lai 4 ky tu cuoi de doi chieu.
- **Khi khong the ghi, man noi ra chu khong ghi.** Draft chi o bo nho, khong co gi duoc ghi tu man nay.

## 4. KHONG claim trong release note

| Khong claim | Ly do |
|---|---|
| Da kiem chung tren trinh duyet | Kiem chung nay chi doc code; khong chay UI/browser |
| Da kiem chung end-to-end voi backend | Khong goi API that, khong dong container |
| Secret khong bao gio bi lo | Preview van giu 4 ky tu cuoi (xem muc 3) |
| Man tim duong dan theo deep link | Man khong doc query param, va khong co link noi bo ra man khac |
| Co the sua revision bat ky | Revision nhap bang chuoi (co datalist), khong phai select |

## 5. Bang chung

Truoc khi dung tai lieu nay o release note chinh thuc, doi chieu lai cac dong sau (cay dang duoc lane khac sua):

    apps/admin-web/src/features/connectors/connectors-screen.tsx
      :113 listConnectors      :136 getConnectorCapabilities   :161 getConnectorRevision
      :205 disableConnector    :225 activateConnector           :238 testConnector
      :268 upsertConnector     :505-509 chon connector ID       :533-536 datalist revision
      :639-641 hai nhanh doc ledger / placeholder                :897-899 nhanh che do nhap

    apps/admin-web/src/features/connectors/state.ts
      :169-177 connectorIdSuggestions   :180-183 comment skipped   :184 parseConnectorList
      :238-242 comment fail-closed       :243 connectorActionGating  :271-283 summarizeConnectorConfig
      :313 comment secret khong persist  :352 va :360 rut secret ve ten

    apps/admin-web/src/features/connectors/curl-import.ts
      :218 MASK   :229-233 maskValue (giu 4 ky tu cuoi)   :551-552 tu choi command substitution

## 6. Gioi han

- **Do bang doc code, khong phai do tuong tac.** Moi claim o muc 2 deu co dong nguon; doi chieu lai dong truoc khi hanh.
- **Chua co bang chung runtime** cho bat ky dieu nao trong muc 2. Phep va doi voi backend la viec cua verifier khac.
- **Ngay dang chay**: mot so lane khac dang sua `apps/admin-web`. File:line co the lech - hay doi chieu lai tai thoi diem phat hanh.

## 7. Ghi chu ve pham vi cong viec

Toi **khong** sua `docs/18-release-readiness-audit.md` hay `docs/18-release-readiness-report.md`. Do la tai lieu readiness chung cua P8, toi khong co lease tren chung, va no khong phai release note draft. Neu y cua ban la gop muc nay vao mot trong hai file do, hay cap lease va cho biet file nao.
