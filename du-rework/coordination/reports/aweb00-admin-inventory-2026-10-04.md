# AWEB-00 — Admin inventory (`/admin/*` → route→DTO→action→owner→test) + phân loại + đề xuất tokens/port

**Packet:** aweb00-admin-inventory · **Lane:** cc_1 · **Date:** 2026-10-04 · **Dispatch:** 2026-10-04T11:05+07:00.
**Status:** READ-ONLY. Không sửa source/test/plan/docs, không tick, không commit, không restart container, không chạm file lane khác (Claude giữ `orchestrator/src`; codex giữ `tasks/ADMIN-WEB-*`). File duy nhất được ghi: receipt này. Mọi claim có `file:line` tự đọc trong working tree hiện tại.

## 1. Shell routing hiện trạng

| URL | Route id | Role tối thiểu | Nguồn |
|---|---|---|---|
| `GET /`, `/admin`, `/admin/` | admin-root | viewer | `shell-router.ts:172-174` |
| `GET/POST /admin/login` | admin-login | viewer | `shell-router.ts:177-179` |
| `POST /admin/logout` | admin-logout | viewer | `shell-router.ts:182-184` |
| `GET /admin/audit` (`AUDIT_NAV_PATH`) | admin-audit | **operator** | `shell-router.ts:189-191` |
| `GET/POST /admin/crypto-config` | admin-crypto-config | **admin** | `shell-router.ts:196-198` |
| `GET /admin/<section>` | section:<name> | theo NAV | `shell-router.ts:201-207` |
| `POST` vào section bất kỳ (không nằm trong mutation-dispatch) | — | — | **405 "Action unavailable"** — `shell-router.ts:279-293` |

NAV canonical (fixtures — nguồn match thật): `p6-01-shell-fixtures.ts:222-230` — `businesses`/`operations`/**`overview`**/**`api-keys`** = viewer; `profiles`/`connectors`/`grants` = **admin**. Lưu ý `view-models.ts:51-57` còn một `ALL_NAV_ITEMS` thứ hai (profiles/connectors = *operator*, thiếu overview/api-keys, thiếu grants-viewer) và **không được dùng ở đâu khác** (grep `ALL_NAV_ITEMS|visibleNavItems` toàn `src` chỉ hit trong chính file) → dead/divergent list, xem F2.

Mutation handlers đang nối thật (`mutation-dispatch.ts:31-118`): `POST /admin/api-keys/new` (issue, tạo raw `du_` phía BFF — `shell-server.ts:374-376`), `POST /admin/api-keys/:id/revoke`, `POST /admin/connectors/:id/revisions/:rev/{test,rotate-secret}`; mọi path khác trả `null` → rơi về 405. CSRF bắt buộc, role admin bắt buộc, `adminAction` thiếu → 503 (`:60`).

## 2. Ma trận route → DTO → action → owner → test → phân loại

`phân loại`: **LW** = legacy working · **SC** = scaffold · **BM** = backend missing · **UM** = UI missing.

| Route (query) | DTO / fetcher (client) | Endpoint hiện trạng (server) | Action (mutation) | Owner (ACUI/PAR/khác) | Test hiện có | Loại |
|---|---|---|---|---|---|---|
| `/admin` (root) | — | — (shell + nav) | — | P6-01 | `admin-shell-render`, `admin-p6-01-shell-fixtures`, `admin-view-model` | **LW** (khung) |
| `/admin/login`, POST login, POST logout | `AdminShellRequest/Response` (`shell-types.ts:47-111`) | session store + OIDC flow (`oidc-flow.ts`, `shell-auth.ts`) | login/logout (cookie/session) | LOCAL-00..04, OIDC-01..04, ACUI-01/02/03 | `admin-shell-auth`, `admin-shell-session-lifecycle`, `admin-oidc-flow`, `admin-shell-oidc-{mount,flow-integration}`, `admin-oidc04-claims-tenant-offline`, `admin-shell-router` | **LW** (token+OIDC); **local mode: BM+UM** (F8) |
| `/admin/businesses` (`?businessId&version&compareVersion`) | `business-section-data.ts` (list/versions) | `GET /api/v1/admin/businesses` (`admin.ts:346`), `GET .../:id/versions` (`:377`), read-only listPage | enable/activate/deactivate là API riêng (`admin.ts:56,97,123`) chưa có form trong section | P6-02, ADM-BASE-01, ACUI-07 (nửa registry) | `admin-business-render`, `admin-business-view-model`, `admin-base-routes` (live-skip) | **LW** |
| `/admin/operations` (`?operationId&cursor&sort&limit`) | `operation-section-data.ts` (list+detail+artifacts) | `GET /api/v1/operations[...]` (public, tenant-fenced); cancel/resume backend có (`POST /api/v1/operations/:id/{cancel,resume}`) | cancel/resume/replay chỉ là **`data-action` discriminator, không form POST** (`operation-section-data.ts:38-39,208-215`) | P6-06, ADM-UX-05, PAR-08, P2-06/08 | `admin-operation-{render,view-model,cockpit}`, `admin-operations-{sql,query,sort,sort-wiring,sort-http-offline,view}`, `operations-list-{contract-conformance,cursor-sort-binding}`, `admin-list-contract-conformance`, `admin-sort-allowlist` | **LW** (read); actions **SC** (nút chưa nối) |
| `/admin/overview` (`?tenantId&from&to`) | `overview-section-data.ts` (usage+audit+operations) | `GET /api/v1/usage` (`:630`), `GET /api/v1/admin/audit` (`:635`), `GET /api/v1/operations` (`:641`) — đều real | — (read-only) | P6-07, ADM-UX-04, PAR-07, COST | `admin-overview-{render,view-model,triage}`, `admin-shell-live-pane` (live-skip) | **LW** |
| `/admin/profiles` (`?businessId&businessVersion&profile`) | `profile-section-data.ts` → `GET /api/v1/admin/profiles/:b/:v/:name` (`:455`) | Route có thật NHƯNG là **projection giả**: trả `revision: 0`, `currentValues: {}`, `capabilities: []` (`admin.ts:450-451`); không có policy persisted | `POST /admin/profiles` → **405** (shell-router.ts:279-293); chỉ có `POST /api/v1/admin/profile-bindings` (`admin.ts:151`) | ACUI-04, **PAR-02/12/13**, T-UI-01..06 | `admin-profile-render`, `admin-profile-view-model` (không có suite policy/admission) | **SC** — không được coi là tính năng đã có (ACUI-M02) |
| `/admin/connectors` (`?connectorId&revision`) | `connector-section-data.ts` → `GET /api/v1/admin/connectors/:id/revisions/:rev` (`:334-335`) | Route có thật NHƯNG **projection giả**: `adapter:'unknown'`, `state:'disabled'`, `secretSlots: []` (`admin.ts:492-495`); hiện deployment còn 404 vì `connectorBaseUrls` không được inject (F3) | rotate/test qua `POST /api/v1/admin/actions` (`mutation-dispatch.ts:40,65-77`) nhưng `credentialWorkflow` không được inject → 503 trên deployment hiện tại (F3) | ACUI-06, **PAR-03/14**, VAULT-* | `admin-connector-render`, `admin-connector-view-model`, `admin-config-cockpit`, `connector-revision-http-offline.functional`, `connector-credentials-offline.functional` | **SC** — projection/ledger thật còn thiếu |
| `/admin/grants` | **không có fetcher** (`defaultSectionFetchers` không có key `grants` — `shell-server.ts:311-345`) và **không có renderer**, không có file `grants-section-*` | Không có route liệt kê grants; dữ liệu grants chỉ xuất hiện lồng trong trang api-keys (`buildApiKeyPage` ghép `profile_bindings`) | — | ACUI-05 (grants phần), PAR-01, ORCH-PAR-05 | không có suite nào cho section này | **UM** (+BM nếu tách màn riêng) |
| `/admin/api-keys` (`?keyId`) | `api-key-section-data.ts` → `GET /api/v1/admin/api-keys[/:id]` (`:283-284`) | `admin.ts:513` (list/by-id real, principal-aware); issue/revoke real (`admin.ts:305` actions) | issue/revoke **đã nối**: mutation-dispatch + BFF copy-once (`mutation-dispatch.ts:38-39,102-114`); **rotate/disable: BM** (chưa có action) | ACUI-05, PAR-01/11, LOCAL-04/OIDC-03 | `admin-api-key-{render,view-model}`, `admin-api-keys`, `admin-action-dispatcher`, `admin-idempotency`, `admin-mutation-atomicity` (live-skip), `admin-keyset-explain` (live-skip) | **LW** (list+issue+revoke); rotate/disable **BM** |
| `/admin/audit` (`?tenantId&severity&action&actor&resource&from&to&sort&cursor`) | `audit-section-data.ts` → `GET /api/v1/admin/audit` (`:523`) | `admin.ts:666` real (ledger + keyset + principal-aware) | — (read-only) | ADM-BASE-01, ADM-UX-03, OIDC-04 (principal) | `admin-audit`, `admin-audit-{query,route,toolbar,list-page,scope}`, `admin-audit-mount` (live-skip), `p8-01-audit-entity-offline` | **LW** |
| `/admin/crypto-config` | `crypto-config-*` (renderer/dispatch/store) | `GET/POST /api/v1/admin/crypto-config` (`admin.ts:575`) real (ENC-08) | POST có handler + CSRF/session (`crypto-config-dispatch.ts:166+`) | ENC-08, ACUI-08, PAR-06 | `admin-crypto-config`, `admin-crypto-config-oidc`, `admin-crypto-config-{wiring,shell}` (live-skip), `admin-config-cockpit` | **LW** |

DTO browser-safe cho app mới: **chưa tồn tại** trong `packages/contracts` cho các màn Admin (hiện DTO nằm trong `src/app/admin/*-section-data.ts` — server-side, không import được từ frontend mới theo contract §1: `docs/admin-ui-development-contract.md:11`).

## 3. Cross-cutting findings (từ chính với `file:line`)

- **F1 — BFF đọc bằng platform bearer (ACUI-M07, P0 trước mọi dữ liệu tenant thật):** `shell-server.ts:365-387` gửi `authorization: Bearer ${options.adminToken}` cho `POST /api/v1/admin/actions`; các fetcher section cũng nhận `adminToken` (`section-dispatch.ts:247-292,330+`). Operator/viewer đang được đọc hộ bằng platform scope; chưa có tenant fence theo session. Chặn: mở Profile/Connector data thật cho operator + bật BFF mới (AWEB-02).
- **F2 — Hai NAV list lệch nhau:** `p6-01-shell-fixtures.ts:222-230` (nguồn match/dispatch, profiles/connectors=admin, có overview+api-keys) vs `view-models.ts:51-57` (profiles/connectors=operator, thiếu overview/api-keys/audit/crypto-config) — list thứ hai không được dùng (grep only-self) nhưng dễ gây nhầm khi port; nên xóa/gộp khi làm AWEB.
- **F3 — Composition thiếu wiring connector:** `main.ts:115-147` không truyền `credentialWorkflow` và `connectorBaseUrls` → connector pane 404 (không base URL) và rotate/test 503 (`mutation-dispatch.ts:60` khi `adminAction` undefined — chú ý `adminAction` chỉ có khi `jsonBaseUrl` set, `shell-server.ts:365`); Vault workflow/ledger thật thuộc PAR-03/14.
- **F4 — Profiles là màn giả:** endpoint trả `revision:0/currentValues {}` (`admin.ts:450-451`), POST section 405 (`shell-router.ts:279-293`). Đúng như ACUI-M02 — **không nhận là tính năng đã có**; chờ PAR-12 backend.
- **F5 — Grants chỉ có vỏ:** NAV có `/admin/grants` (fixtures:228) nhưng không fetcher/renderer (F5 = hệ quả F2/§2) → bấm vào chỉ thấy shell trống.
- **F6 — Operations actions chưa nối:** nút cancel/resume/replay chỉ là discriminator (`operation-section-data.ts:38-39`); backend cancel/resume có trên public API nhưng chưa có form POST admin → mọi POST section 405.
- **F7 — API key lifecycle thiếu rotate/disable:** dispatcher có `apikey.issue/revoke` (BFF đã dùng) nhưng không có `rotate/disable`; raw key đang sinh ở BFF `du_+32B` (`shell-server.ts:374-376`) trong khi legacy sinh server-side (`app/api/internal/apikeys/route.ts:82`) — delta shape cần Product chốt (PAR-11).
- **F8 — Local auth mode chưa có mặt:** không có `DU_ADMIN_AUTH_MODE` trong `main.ts` (grep = 0; plan LOCAL-03 yêu cầu); `ADMIN_TOKEN` vẫn là đường login shell duy nhất ngoài OIDC; LOCAL-01/02 primitives đã có nhưng chưa mount.

## 4. Visual tokens — đề xuất (map legacy → rework, 1 nguồn)

Nguồn hiện có: rework `shell-render.ts:500` (light) + `:503-504` (dark, theo `prefers-color-scheme`) + focus ring `:514-518` + motion-reduce `:506-513`; legacy `app/globals.css:6-32` (light), `:34-59` (.dark class), alias `:61-79`; Tailwind legacy `tailwind.config.ts:11-47`. Đề xuất **giữ token rework `--cf-*` làm nguồn duy nhất** cho app mới và map semantic cũ sang nó (khi hai UI cùng tồn tại — đúng yêu cầu contract §3: `docs/admin-ui-development-contract.md:33`):

| Legacy semantic (`globals.css`) | Rework token (`shell-render.ts:500`) |
|---|---|
| `--primary` #2563eb (CTA) | `--cf-blue` #0051C3 (hành động) / brand accent `--cf-orange` #F38020 (nav/mark) — **cần chốt màu CTA** (Q2) |
| `--background` #f8fafc | `--bg-canvas` #F3F4F6 |
| `--card`/`--popover` #fff | `--bg-card` #FFFFFF |
| `--border`/`--input` #e2e8f0 | `--border-subtle` #E5E7EB / `--border-dark` #D1D5DB |
| `--muted` #f1f5f9 | `--bg-subtle` #F9FAFB / `--bg-hover` |
| `--muted-foreground` #64748b | `--text-sub` #6B7280 (và `--text-muted` #4B5563) |
| `--foreground` #0f172a | `--text-main` #111827 |
| `--destructive` #dc2626 | `--badge-danger-{bg,text,border,dot}` |
| `--accent` #eff6ff | `--cf-blue-light` #EBF3FF |
| (success/warning/info) | `--badge-{success,warning,info}-{bg,text,border,dot}` |
| radius 8px (`tailwind.config.ts:45-47`) | `--radius-md` 8px (`--radius-sm` 6px) |
| font Inter (legacy `sans` có Be Vietnam Pro trước) | Inter (`shell-render.ts:528`) — legacy heading Plus Jakarta: **không có bản rework** (Q3) |

Dark mode: rework dùng media query (không class). App mới cần chốt cơ chế theme toggle (class `dark` như legacy next-themes hay media + preference) — Q4.

## 5. Đề xuất port component legacy (KHÔNG copy code)

Legacy: `components/ui/{Button,Input,Card,Badge,Modal,ConfirmDialog,Tabs}.tsx` + `StatusBadge.tsx` + app-level component (glob `components/**`). Legacy deps liên quan: `lucide-react`, `tailwind-merge`, `next-themes`, `sonner` (`package.json:36,42,52,54`); **không có Radix/shadcn** → các ui component là code tự viết, không phải shadcn gốc.

| Legacy component | Props/đặc điểm (đã đọc) | A11y/port ghi chú | Đề xuất |
|---|---|---|---|
| `ui/Button.tsx` | 7 variant, 5 size, `isLoading/leftIcon/rightIcon`, focus ring primary | focus-visible có; thiếu `type="button"` mặc định (kế thừa HTML) | **viết lại** bằng shadcn Button + prop tương đương (giữ tên variant để feature dễ chuyển) |
| `ui/Badge.tsx` | 8 variant + `dot` | semantic `span` | **viết lại** bằng shadcn Badge + map `--badge-*` rework |
| `ui/Card.tsx` | Card/Header/Title/Description/Content/Footer | thuần layout | **viết lại** (shadcn Card) |
| `ui/Input.tsx` | `label/error/helperText/leftIcon/rightIcon`, `useId` gắn `htmlFor` | label-input ok; error chưa gắn `aria-describedby`/`aria-invalid` | **viết lại** (shadcn Input + field wrapper, bổ sung aria-describedby/invalid) |
| `ui/Modal.tsx` | portal, `role=dialog`+`aria-modal`, Escape, backdrop click, body overflow lock | **không focus-trap, không đặt focus ban đầu, không trả focus, không khóa scroll bằng inert** | **viết lại** bằng Dialog primitive (Base UI) — không port |
| `ui/ConfirmDialog.tsx` | compose Modal+Button, `isDestructive/isLoading`, nhãn tiếng Việt mặc định | phụ thuộc Modal | **viết lại** theo Dialog mới, giữ prop shape |
| `ui/Tabs.tsx` | `items/activeId/onChange`, variant pill/underline, `role=tablist/tab`+`aria-selected` | **thiếu roving tabindex/Arrow keys** | **viết lại** (shadcn Tabs) |
| `StatusBadge.tsx` | 5 trạng thái conversion legacy (`compressing`…), nhãn tiếng Việt, palette hardcode | không khớp state rework | **bỏ** (rework dùng badge status từ shell tokens; nếu cần badge chung thì làm trong component mới) |
| App-level: `HeaderNav`, `DashboardView`, `ConversionHistory`, `ChatConsultant`, `MarkdownEditor/Preview`, `SettingsForm`, `ServiceTestClient`, `SessionProviderWrapper`, `ThemeProvider/Toggle`, `PageWrapper` | gắn legacy API/feature (recharts, react-markdown, next-auth, next-themes) | — | **bỏ** — không thuộc Admin Web mới; chỉ tham chiếu pattern theme-toggle/light-dark nếu cần |

License: toàn bộ là **first-party code trong repo** (không header third-party) → không rào cản license khi rewrite; shadcn/Base UI là MIT — vẫn cần review diff CLI khi `add` (contract §2). Không import xuyên app (contract §1:9).

## 6. Open questions (chờ user/coordinator chốt — không tự quyết)

1. **Q1 — nhận bảng phân loại §2**: 3 màn `SC` (profiles/connectors, + phần actions của operations) và 1 màn `UM` (grants) giữ đúng nhãn, không “đã có”.
2. **Q2 — màu CTA chính của app mới**: `--cf-blue` (hành động, như shell hiện tại) hay đổi brand sang `--cf-orange`? Legacy CTA là blue #2563eb.
3. **Q3 — typography**: giữ Inter thuần (rework) hay thêm Plus Jakarta cho heading (legacy)?
4. **Q4 — theme strategy**: media-query (rework hiện tại) vs class `dark` + toggle (legacy next-themes)?
5. **Q5 — port scope component** (§5): xác nhận toàn bộ “viết lại”, không port code; StatusBadge legacy bỏ.
6. **Q6 — grants**: tách màn riêng (UI+route mới, cần owner) hay hợp nhất vào api-keys như hiện tại và gỡ grants khỏi NAV?
7. **Q7 — Profiles rollout**: ẩn màn cho tới khi PAR-12 backend + VFY-LOCAL xong hay giữ scaffold read-only?
8. **Q8 — Connectors composition**: ai cấp lease `main.ts` để inject `credentialWorkflow`/`connectorBaseUrls`; có làm trước AWEB-05 không (F3)?
9. **Q9 — Local auth mode (LOCAL-00)**: default `local|oidc|both`; token-login có giữ song song khi mount React app (F8)?
10. **Q10 — route rollout flag**: cơ chế `AWEB-01` (server flag per route) + ai giữ lease `shell-router.ts`/`server.ts` khi bật dần từng màn?
11. **Q11 — `apps/admin-web` vào `pnpm-workspace.yaml`**: owner/lease (AWEB-01) và thời điểm (tránh trùng lockfile với lane khác).
12. **Q12 — ACUI-M07 fence**: thứ tự làm BFF session/tenant-fence (AWEB-02) trước khi mở operator đọc tenant data — xác nhận không bật trước.

## 7. Verdict

- Inventory **đủ 11 route** (`/admin` + login/logout + 8 section + crypto-config/audit) với phân loại: **LW = 8** (root, login/OIDC, businesses, operations-read, overview, api-keys phần list/issue/revoke, audit, crypto-config), **SC = 2.5** (profiles, connectors, + actions của operations/rotate-disable của api-keys), **UM = 1** (grants), **BM** ghi rõ ở profiles-policy, connector-ledger/composition, api-key rotate/disable, local-auth mode.
- Không có màn nào bị “nhận nhầm là đã có”: các projection giả (`admin.ts:450-451,492-495`), nút chưa nối (`operation-section-data.ts:38-39`) và 405 POST (`shell-router.ts:279-293`) đã được liệt kê tường minh.
- Đề xuất tokens (§4) và port component (§5) sẵn sàng để AWEB-01/03 dùng; các điểm chờ chốt nằm ở §6.
- READ-ONLY: không file nào khác được ghi; không tick gate; không commit.
