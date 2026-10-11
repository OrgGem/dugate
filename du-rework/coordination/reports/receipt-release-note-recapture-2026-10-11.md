# Receipt - chup lai file:line cho Connectors va cap nhat release note draft

| Muc | Gia tri |
|---|---|
| Ngay | 2026-11 (ky thuc cua bo may: 2026-10-11) |
| Repo scope | du-rework |
| De bai | chup lai file:line va cap nhat release note draft |
| Co ban draft nao de cap nhat? | **KHONG** - khong ton tai file release-note draft nao (xem §2) |
| Van pham | 2 file markdown, khong sua code san pham |

## 1. Cai toi da lam

1. **Chup lai toan bo trich dan** trong tai lieu Connectors bang script, khong suy tu do luong file.
2. **Sua 5 trich dan lech** (xem §4).
3. **Tao ban draft release note** tai `release-note-draft-connectors-2026-10-11.md`, chi noi tu cac claim da kiem chung.

## 2. Khong co ban draft nao truoc day

Toi tim `*release-note*` va `*release*` toan repo. Khong co file draft nao. Cac file ton tai la tai lieu readiness chung cua P8:

    docs/18-release-readiness-audit.md       (P8-08 - co muc `Release gates`)
    docs/18-release-readiness-report.md
    tasks/P8-release-readiness.md

**Toi KHONG sua cac file do.** Toi khong co lease tren chung, no la tai lieu chung cua P8, va no khong phai release note draft. Do la ly do toi tao ban draft rieng.

⇒ Neu y cua ban la gop muc Connectors vao `docs/18-release-readiness-audit.md`, hay cho biet va cap lease. Toi se them muc rieng thay vi sua tai lieu chung.

## 3. Ket qua chup lai file:line

Tim doan doc trung thanh 36 kiem tra (dieu 1: dong chua chuoi mong doi). Ket qua:

    CITATIONS_OK 33/36

Ba dong con lai la **loi cua phu kiem truy van, khong phai loi trich dan.** Noi dung do la:

| Phu kiem tra noi | Thuc te | Ket luan |
|---|---|---|
| `:87` chua `CSRF token` | doan do `:86-87` (dong 87 la phan tiep: `client and must ride every mutation below.`) | trich dan dung |
| `state.ts:183` chua cau `never repaired...` | day la ket thuc doan `*/`, noi dung 2 dong: `:181-182`; doan `:180-183` | trich dan dung |
| `state.ts:242` chua `advertised that capability` | cung la ket thuc `*/`; noi dung `:239-241`; doan `:238-242` | trich dan dung |

Toi ghi dieu nay de ai doc biet rang ba canh bao do khong phai suy nghi. Toi da doc chinh doan truoc khi ket luan, khong doan tu suy suy.

## 4. Nam trich dan bi lech va da sua

| O truoc do | Sau do | Vi sao sua |
|---|---|---|
| `connectors-screen.tsx (:86-87)` cho client | giu `:86-87` cho comment, them `:88` cho `useMemo(...)` khai bao client | trich dan truoc do khong noi chinh xac dong nao |
| `state.ts:180-181` cho comment `skipped` | `state.ts:180-183`, them `:184` cho `parseConnectorList` | doan comment la `:180-183` |
| `state.ts:237-239` cho comment fail-closed | `state.ts:238-242`, `connectorActionGating` van `:243` | dong 237 la dong trong; doan la `:238-242` |
| `state.ts:342-376` cho nut `rutt secret ve ten` | `:313` cho comment, `:352` cho header, `:360` cho form field, `:371` cho `secretPresent` | doi thuc tich thanh 4 moc cu the |
| `connectors-screen.tsx:506-508` cho NativeSelect va `:533` cho datalist | `:505-509` cho NativeSelect (tu option `:505` den dong `</NativeSelect>` `:509`); `:533-536` cho datalist | doi thanh doan, khong con dang cau rieng le |

Trich dan dang co dung khong sua. Trong do: `:113`, `:136`, `:161`, `:238`, `:268`, `:354`, `:640`, `:641`, `:898`, `:899`, `:169-177`, `:177`, `:243`, `:271`, `:313`, `:551-552`, `:229-233`, `:232`, `:552`.

## 5. Ban draft release note

Tai `release-note-draft-connectors-2026-10-11.md`, co trang thai **DRAFT**. Noi dung:

- Tom tat va 8 diem xac nhan, moi diem deu co dong nguon.
- Muc `Khong noi ro`: preview giu 4 ky tu cuoi cua secret, va khong ghi gi khi khong the ghi. Day la hai diem nguoi dung co the thay, cho nen noi ro thay vi che.
- **Muc cam claim** (5 dong) - viec nay toi ghi manh, vi do la noi release note hay sai nhat: khong claim kiem chung tren trinh duyet, khong claim end-to-end, khong claim che hoan toan, khong claim deep link, khong claim sua duoc moi revision.
- Bang dong file:line cho doi chieu lai.

**Khong claim doi chu:** doan bang chung va doan gioi han toan tu doc code. Toi khong chay trinh duyet va khong goi API.

## 6. Danh sach file da cham vao

    docs-connectors-screen-honest-audit-2026-10-10.md          85 dong   dquotes 0   trailingWs 0
    release-note-draft-connectors-2026-10-11.md                66 dong   dquotes 0   trailingWs 0
    receipt nay                                               moi

Toi **khong sua** san pham. Toi **khong sua** docs/18-*.

## 7. Gioi han cua bang chung

1. **Do doc code, khong phai do tuong tac.** 36 kiem tra trich dan la do dong code, khong do hanh vi thuc thi.
2. **Ngay da sang 2026-10-11.** Cac file Connectors hien tai van khop do luong khao sat (996/379/593/279). Nhung ne khi ban lam release note, chay lai script trich dan o muc 3 truoc khi hanh.
3. Ban draft la **DRAFT**. Chua duyet, khong phat hanh.

## 8. Verdict

| Hang muc | Ket qua |
|---|---|
| Chup lai toan bo trich dan | **36 kiem tra** |
| Trich dan lech duoc sua | **5 dong** |
| Ban draft | **DA TAO** |
| Do docs/18-* | **KHI QUYEN** - khong co lease; xem §2 |
| Hygiene | **0 nhay kep, 0 trailing ws** |

⇒ **DA GIAO.** Hay doi chieu lai bang dong file:line o muc 5 truoc khi dung ban draft vao release note. Va cho toi biet neu ban muon noi dung nay vao `docs/18-*` - do can lease rieng.
