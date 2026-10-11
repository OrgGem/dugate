# Connectors screen - kien truc va danh gia tinh trung thuc (nguon cho release note)

| Muc | Gia tri |
|---|---|
| Ngay | 2026-10-10 (Asia/Bangkok) |
| Scope doc | orchestrator/apps/admin-web/src/features/connectors/ (4 file, 2247 dong) |
| Nguon | re-verify truc tiep tren source cua khao sat `survey-workflows-connectors-2026-10-10.md` §3 |
| Van pham | doc-only, 0 sua code san pham |

## 0. Phuong phap va ranh gioi

Toi **re-verify lai** tung diem cua §3 thay vi dua lai ket luan cu, vi cay dang co lane khac sua. Ket qua: **khong co diem nao lech**; dong va do lon cung giong luc khao sat.

**Khong da xac minh (phai ghi trong release note neu co y dinh dung):**

- Khong chay UI/browser, khong goi API that, khong dong container.
- Moi phat bieu trong tai lieu nay deu tu **doc code**, khong phai do tuong tac. Ha nghiem ve trai nghiem la suy ra.
- Do lech giua `apps/admin-web` (UI) va backend khong do duoc: tai day **khong** co gi chay `tsc`, test hay browser.

## 1. Kien truc

| File | Dong | Vai tro |
|---|---:|---|
| `connectors-screen.tsx` | 996 | Man hinh: doc danh sach, doc revision, va ghi qua cac action |
| `state.ts` | 379 | Doc/validate thuan: gate theo capabilities, goi y ID, tom tat config, xay draft |
| `curl-import.ts` | 593 | Parse curl thanh draft, mask secret, tu choi command substitution |
| `curl-import-preview.tsx` | 279 | Hien preview cua draft |

**Duong du lieu:** SPA -> BFF `/admin/api/*` (same-origin) -> upstream. Mot client duy nhat cho ca man: comment `connectors-screen.tsx:86-87`, khai bao `useMemo` tai `:88`; CSRF token phai di theo moi mutation, nen dung chung client la mot rang buoc kien truc, khong pha toi uu hoa.

**Kiem soat mo quyet dinh:** man tu doc quang nang `management`/`test` tu chinh quang ca cua no tai `:136`, roi moi quyet dinh nut nao bat. Mot man khong bao gio tu mo quyen.

## 2. Danh gia tinh trung thuc - tung claim va bang chung

| Claim | Bang chung | Verdict |
|---|---|---|
| Khong co mock data | 9 API call, khong con mot hang danh sach tinh san: `listConnectors` `:113`, `getSession` `:129`, `getConnectorCapabilities` `:136`, `getConnectorRevision` `:161`, `disableConnector` `:205`, `retireConnector` `:207`, `activateConnector` `:225`, `testConnector` `:238`, `upsertConnector` `:268` | **XAC NHAN** |
| Goi y connector ID khong hard-code | `connectorIdSuggestions` (`state.ts:169-177`) lay tu danh sach management khi co, nguoc lai tu `capabilities.knownConnectorIds`, roi `Set` khu trung | **XAC NHAN** |
| Nut ghi chi bat khi backend tu quang ca | `connectorActionGating` (`state.ts:243`): `null` (khong doc duoc quang ca) gate **tat** cac nut ghi; comment `state.ts:238-242` goi ro la fail-closed | **XAC NHAN** |
| Trang thai suy giam duoc gan nhan, khong nham la that | `:639-641`: khi doc tu connector ledger thi ghi `header values arrive [REDACTED] and config is rendered as keys only`; nguoc lai `:641`: `adapter/capabilities are placeholders, not connector truth` | **XAC NHAN** |
| Che do nhap noi ro khong ghi duoc gi | `:897-899`: `the draft stays local and nothing can be written from here - nothing is faked` | **XAC NHAN** |
| Config chi hien ten khoa, khong hien gia tri | `summarizeConnectorConfig` (`state.ts:271-283`) tra `keys`, `headerNames`, `redactedHeaderNames` - khong tra value | **XAC NHAN** |
| Ghi di khong mang secret trong payload | Comment `state.ts:313` noi ro secret **khong** duoc persist; header co ten secret bi rut ve ten tai `:352`, secret form field tai `:360`; man hien `secretPresent` boolean (`:371`) | **XAC NHAN** |
| Reader khong sua hong thanh dep | Comment `state.ts:180-183` ngay tren `parseConnectorList` (`:184`): dong khong qua reader duoc dem vao `skipped` - khong loai bo am tham, khong sua cho no co ve | **XAC NHAN** |
| Import curl che secret | `maskValue` (`curl-import.ts:229-233`); header khong secret chi hien do dai (`:528`) | **XAC NHAN - xem §4.1** |
| Import curl tu choi command substitution | `curl-import.ts:551-552` tra loi `COMMAND_SUBSTITUTION_UNSUPPORTED` khi gap `$(`, backtick, `<(`, `>(` | **XAC NHAN** |
| Khong link chet | Trong feature chi co mot anchor (`/admin/login` tai `:354`), khong co `Link`/`to=` noi bo, khong co `useSearchParams` | **XAC NHAN** |

## 3. Release note DUOC phep claim

1. Man Connectors doc **mot du lieu that**; khong co hang mau hay so gia trong man.
2. Moi nut ghi chi hoat dong khi chinh deployment do quang ca nang luc do; khong doc duoc quang ca thi **tat nut** va ghi ro ly do.
3. Khi backend khong compose store connector, man **tu noi** dang hien thi chi la placeholder chu khong phai connector truth.
4. Config chi hien **ten khoa**; gia tri header den `[REDACTED]`; payload ghi khong mang secret.
5. Danh sach goi y connector ID lay tu backend, va nhanh san tay cho phep nhap ID khi can.
6. Co cong dan curl: tu chan command substitution, che secret, bao loi co ma.

## 4. Release note KHONG DUOC claim

| Khong claim | Vi sao |
|---|---|
| Man da duoc kiem chung tren trinh duyet | Toi khong chay UI/browser; moi phat bieu la doc code |
| Man da duoc kiem chung voi backend that | Toi khong goi API; khong co bang chung runtime nao |
| Secret khong bao gio duoc lo | Xem 4.1 - van co **4 ky tu cuoi** hien trong preview |
| Man tim theo duong dan/deep link duoc | Khong doc query param; khong co link noi bo ra man khac |
| Co the sua revision bat ky | Revision nhap **dung chuoi** trong input co datalist; khong phai `<select>` |

### 4.1 Diem can noi ro neu release note noi ve che secret

`maskValue` (`curl-import.ts:229-233`) tra `****` neu ngan hon hoac bang 4 ky tu, con lai tra `****` + **4 ky tu cuoi**. Day la quy uoc xem truoc pho bien, khong phai loi - nhung no **lo ro 4 ky tu cuoi cua secret** ma nguoi dung dan vao. Preview chi ton tai o client.

Neu release note dung tu che hoan toan, cau phai la: `che secret trong preview import, giu lai 4 ky tu cuoi de doi chieu`.

### 4.2 Hanh vi con lai, khong phai loi

- **Revision nhap tu do**: `:533-536` dung datalist, hop ly vi so revision la so nguyen co rat nhieu gia tri hop le; khac voi connector ID da dung NativeSelect tai `:505-509` (cac `<option>` sinh tu `connectorSuggestions`).
- **Khong co deep link**: khac voi Audit/Trace, man nay khong doc query param. Neu muon them phai mo lease.
## 5. Chi so file:line

    features/connectors/connectors-screen.tsx   996 dong
    features/connectors/state.ts               379 dong
    features/connectors/curl-import.ts         593 dong
    features/connectors/curl-import-preview.tsx 279 dong

Truoc khi dung lai tai lieu nay de viet release note, **doi chieu lai file:line**: mot so lane khac dang lam viec tren cung cay.
