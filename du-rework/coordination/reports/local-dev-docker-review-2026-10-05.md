# Review local build/dev và Docker deployment — 2026-10-05

Yêu cầu trực tiếp: rà soát từng service và toàn bộ dịch vụ của `du-rework`. Đây là review + validation; không sửa product source, Dockerfile, Compose, spec, migration, task row hoặc coordinator ledger; không commit. Build sinh/cập nhật dist như bình thường. Không chạy dev launcher hoặc migrate vào DB hiện có; không chạy Compose up/down. Smoke containers dùng `--rm --network none`, không bind data hoặc mở port.

**Kết luận:** local core build hoạt động trên workspace hiện tại, nhưng `build:all` chưa bao phủ mọi app/business. Docker full stack chưa deploy được; Compose root lỗi conflict, 3/5 image build fail và hai image build đạt vẫn có boot/config blockers.

## Môi trường và bằng chứng

- Workspace: `D:/Git/dugate/du-rework`; Windows PowerShell; local Node 22.16.0; Docker Engine 28.5.1; Compose v2.40.3-desktop.1. Dockerfile base `node:20-alpine` resolve Node 20.20.2 trong smoke run.
- Rà soát/build khoảng 12:28–12:38 Asia/Bangkok ngày 2026-10-05. Source là working tree đang có nhiều thay đổi chưa commit; không gán kết quả này cho HEAD.
- Docker build từ context snapshot khoảng 14 MB trong temp dir, lưu path tại [context.txt](build-deploy-review-2026-10-05-context.txt). Copy source `packages/services/businesses`, workspace manifests/config, integration manifest; loại `node_modules`, `dist`, `.tsbuildinfo`, `.env*` và artifacts. Các Dockerfile gốc vẫn được dùng nguyên văn; snapshot chứa đầy đủ các đường COPY cần thiết, không dùng host dist.
- Chỉ có hai image review được tạo thành công: `du-review-connector:20261005`, `du-review-document-core:20261005`. Không đổi tag deployment `latest`/image đang chạy. Smoke container đã tự xóa bằng `--rm`.

## Ma trận từng service

| Service / app | Build local riêng | Docker build | Compose riêng `config -q` | Boot/deploy nhận xét |
|---|---|---|---|---|
| Orchestrator | Exit 0 | **Exit 1**: `ERR_PNPM_IGNORED_BUILDS` | Exit 0 | Dockerfile còn thiếu base tsconfig/dependency builds/UI assets; Admin shell env/port chưa wired |
| Connector | Exit 0 | Exit 0 | Exit 0 | **Default entrypoint smoke exit 255**: CRLF shebang; bypass entrypoint thì thiếu secret bắt buộc, exit 1 |
| Document Core | Exit 0 | Exit 0 | Exit 0 | **Default optional-env smoke exit 1**: URL/token rỗng; worker không chung network với Connector |
| LC Checker | **Exit 1**: local node_modules chưa có, thiếu `tsc` | **Exit 1**: Connector `TS5058` | Exit 0 với synthetic required env | Worker-only Compose cần reachable external runtime/connector/Redis; không nằm trong Compose root |
| Example Review | Exit 0 | **Exit 1**: Connector `TS5058` | Exit 0 | Entry script trong working tree còn CRLF; proof Compose dùng pinned images, không phải stack production tổng |
| Admin Web | Exit 0, có cảnh báo bundle >500 kB | Không có image riêng; không được COPY/build vào Orchestrator image | Không có service riêng | Là assets của Admin shell; phải đóng gói và phục vụ từ shell, không coi Vite server là deployed UI |

`config -q` pass chỉ chứng minh Compose parse được, không chứng minh image boot, auth, migration hay business journey.

## Findings ưu tiên

### HIGH — RDEV-01: Compose root không hợp lệ

`docker-compose.yml:12–15` include ba Compose tự khai báo infra. `services/orchestrator/docker-compose.yml:42`, `services/connector/docker-compose.yml:39`, `businesses/document-core/docker-compose.yml:33` khai báo lại các resources cùng tên; root còn khai báo postgres/valkey tại `docker-compose.yml:19–48`.

Expected: một lệnh Compose root tạo toàn stack. Actual: `docker compose ... config -q` exit 1 với `services.postgres conflicts with imported resource` (lượt khác trả `services.valkey conflicts with imported resource`). Comment nói infra được merge/override qua include không đúng với hành vi đã đo. Chặn trước build/up.

Đề xuất: shared infra duy nhất; service fragments không lặp infra; các wrapper standalone ghép shared infra + fragment. Validate root và từng wrapper trước khi up. Không dùng include như cơ chế override resource.

### HIGH — RDEV-02: Orchestrator image build không reproducible và thiếu input build

`services/orchestrator/Dockerfile:14–16` không pin pnpm; thực tế Corepack lấy pnpm **12.9.1**, install fail `ERR_PNPM_IGNORED_BUILDS`, dependency `msgpackr-extract@3.0.4`, Docker build exit 1. Các image khác pin 10.18.3.

Các blocker tiếp theo từ source inspection, chưa tới compiler trong lượt build gốc: `Dockerfile:6` không COPY `tsconfig.base.json` dù `services/orchestrator/tsconfig.json:2` extends file này; `Dockerfile:16` chỉ build Orchestrator, không build các workspace dependencies trong `packages`, trong khi `.dockerignore` loại mọi dist. Local warm workspace che các lỗi này.

Đề xuất: pin package manager; chốt dependency-build policy ở repo; COPY base tsconfig; build runtime dependency graph trước service; cold-build từ context không có dist. Không tự chạy approve-builds như một bước deployment chưa kiểm soát.

### HIGH — RDEV-03: LC Checker và Example Review image fail ở dependency graph

`businesses/lc-checker/Dockerfile:9` và `businesses/example-review/Dockerfile:9` chỉ COPY Connector package.json, nhưng `:20` build bằng filter có `...`. `packages/worker-sdk/package.json` có devDependency `@du/connector`; actual recursive graph chạy Connector build và fail `TS5058: The specified path does not exist: 'tsconfig.json'` tại `/app/services/connector`.

Expected: build độc lập worker với đầy đủ source của graph cần build. Actual: cả hai Docker build exit 1 trước worker. Đề xuất phân biệt runtime build deps/test-only deps; hoặc cung cấp đầy đủ source/tsconfig cho mọi node thực sự được chọn. Không dựa host dist để lách cold build.

### HIGH — RDEV-04: Connector entrypoint không chạy từ Windows checkout

`services/connector/entrypoint.sh:1` có CRLF, bao gồm shebang; Dockerfile chỉ chmod, không chuẩn hóa line endings. Image build exit 0 nhưng `docker run --rm --network none ... du-review-connector:20261005` exit **255**, `exec ./entrypoint.sh: no such file or directory`. File có mặt trong image; lỗi xảy ra ở interpreter của shebang.

`businesses/example-review/entrypoint.sh:1` cũng có CRLF trong working tree; chưa smoke image này vì build fail trước đó. LC Checker script có LF.

Đề xuất `.gitattributes` ép LF cho shell scripts và kiểm shebang trong build; hoặc dùng Node CMD/ENTRYPOINT trực tiếp khi script chỉ exec Node. Giữ finding Example Review là source risk, không nhận là boot đã kiểm chứng.

### HIGH — RDEV-05: Document Core default Compose env không hợp schema

`businesses/document-core/docker-compose.yml:14–15` luôn inject `CONNECTOR_URL=''`, `CONNECTOR_SERVICE_TOKEN=''` nếu unset. `src/config.ts:8–11` chấp nhận undefined, nhưng từ chối empty URL/token. Smoke image với chính hai giá trị mặc định này exit **1**, `Invalid worker configuration`. Đây không phải lỗi network hay DB.

Đề xuất thống nhất optional-env policy (bỏ env chưa cấu hình hoặc normalize empty thành undefined trước validation); nếu Connector bắt buộc ở deployment thì require URL/token và advertise rõ. Không báo worker healthy từ image build.

### HIGH — RDEV-06: Admin UI chưa có đường deploy thực trong Compose

`services/orchestrator/docker-compose.yml:14–24` không truyền `ADMIN_SHELL_COOKIE_SECRET`, `ADMIN_SHELL_PORT`, `ADMIN_SHELL_HOST`, `DU_ADMIN_WEB*` và không expose shell port. `services/orchestrator/src/main.ts:190–192` cấu hình shell thành listener riêng; `src/app/admin/shell-server.ts:963–969` không mount nếu thiếu secret, default host loopback. Dockerfile không COPY/build `apps/admin-web`; `.dockerignore` còn loại dist của app.

Expected: operator truy cập Admin UI sau deploy theo guide. Actual theo source: Compose hiện chỉ mở API 3000, shell không được cấu hình; kể cả bật React flag ở host `.env`, env đó không được truyền vào container, assets không tồn tại. Không có bằng chứng API 3000 tự phục vụ Admin shell.

Đề xuất build UI assets trong image; wiring shell secret/port/bind address/rollout flags; expose qua reverse proxy hoặc port riêng; test login và assets trên image thật. Không bật cutover mặc định trong packet sửa build.

### HIGH — RDEV-07: Worker → Connector không chung network; local sample lệch port

`businesses/document-core/docker-compose.yml:25–26`: worker chỉ ở `du-worker-net`; `services/connector/docker-compose.yml:27–28`: Connector chỉ ở `du-platform-net`. Vì vậy đặt `CONNECTOR_URL=http://connector:8080` chưa đủ để hai container trao đổi trực tiếp. Compose Document Core standalone cũng không tạo Connector.

Local `.env.local.sample:26` đặt Connector listener **8088** nhưng `:36` đặt worker URL **8080**. Worker nhận token nhưng không tới đúng listener.

Đề xuất network chung cho leg worker→Connector (theo boundary đã chốt), URL và service identity hợp lệ; local sample lấy cùng cổng với entrypoint. LC worker standalone cần URL ngoài mạng default của riêng project nếu không tham gia shared network.

### HIGH — RDEV-08: Đổi host port làm hỏng internal listener/healthcheck

`services/orchestrator/docker-compose.yml:15,26,36` và `services/connector/docker-compose.yml:11,21,30` dùng cùng biến cho listener nội bộ và published host port nhưng target/healthcheck vẫn cố định 3000/8080. Source boot đọc PORT.

Read-only resolved-config probe xác nhận: `ORCHESTRATOR_PORT=3100` → process PORT 3100, Docker target 3000, healthcheck 3000. `CONNECTOR_PORT=8188` → process PORT 8188, target/healthcheck 8080. Compose vẫn parse pass nhưng traffic/health fail. Duplicate Orchestrator block trong Document Core có cùng lỗi.

Đề xuất giữ container listener cố định, chỉ dùng biến host port ở ports; hoặc đổi target, healthcheck và service URLs đồng bộ.

### HIGH — RDEV-09: Local dev launcher có thể kill process ngoài DUGate

`scripts/dev.cjs:73–78` tự chạy stop-all khi phát hiện các port 3000/3001/8088/8091; `scripts/stop-all.cjs:34–41,81` thêm mọi PID listener rồi taskkill trước khi có kiểm chứng command line là DUGate. Nhánh POSIX cũng lấy PID từ port. Shutdown dev runner còn gọi broad stop-all lần nữa tại `dev.cjs:130–131`.

Expected: chỉ dừng child processes thuộc lượt dev hiện tại, báo port conflict nếu process khác chiếm. Actual theo code: process không thuộc DU trên các port này có thể bị dừng. Vì thế review này không chạy launcher trên shared host.

Đề xuất track PID/process group sở hữu, kiểm executable/path/start time, không tự kill theo port. POSIX spawn chưa detached nhưng shutdown dùng `process.kill(-child.pid, ...)` (`dev.cjs:168–172,123`), nên group shutdown cũng cần sửa/verify.

### MEDIUM — RDEV-10: Build/dev “all” bỏ app và không rebuild source

`scripts/build-all.cjs:25–35` chỉ có 6 shared packages + Orchestrator/Connector/Document Core; bỏ LC Checker, Example Review và Admin Web. Đã đo script exit 0, 9/9 bước, nhưng đây không phải tất cả workspace.

`dev.cjs:85–89` chỉ kiểm entry dist có tồn tại, không kiểm freshness; `:163–166` dùng Node `--watch` trên JS dist mà không chạy tsc/Vite watcher. Sửa TS/TSX sẽ không tự compile. Dev runner cũng không build/launch Admin Web.

`pnpm build` có coverage rộng hơn (scope 15/16 workspace projects) nhưng lượt thực exit 1 ở LC Checker vì package node_modules chưa cài. Đây là environment prerequisite đã quan sát, không kết luận LC source không compile; Docker LC failure là finding RDEV-03 riêng.

Đề xuất tách rõ build core/build workspace, validate graph closure, source watchers, UI assets/HMR proxy về same-origin BFF. Vite config hiện không có proxy; chạy Vite riêng chưa đảm bảo `/admin/api/*` tới shell backend.

### MEDIUM — RDEV-11: Local readiness/exit handling báo sai trạng thái

`dev.cjs:34` coi cả 404/401/403 là ready; `:104` nuốt migration failure rồi tiếp tục; `:213–216` health timeout vẫn launch worker; `:187–190` child exit chỉ log, không fail runner. Health endpoint/cổng hardcode 3000 bất kể env. Per-service PS start scripts build khi thiếu dist nhưng không kiểm exit build trước launch.

Đề xuất migrate failure fail-fast; readiness phải đúng endpoint và 2xx/ready payload; dependency timeout không báo thành công; propagate child failure; URL lấy từ cấu hình. Với clean production DB phải chạy migrate explicitly như guide, không coi `AUTO_MIGRATE=false` + `up` là tự tạo schema. Document Core standalone duplicate Orchestrator block còn không forward AUTO_MIGRATE.

### MEDIUM — RDEV-12: Connector secrets cho phép Compose parse nhưng không boot

`services/connector/docker-compose.yml:17–19` default secret rỗng; `services/connector/src/entrypoint.ts:16–20` require service identity secret, invocation grant secret và encryption key. `.env.example` để trống để operator điền, nhưng Compose validation không enforce.

Sau bypass shell entrypoint bằng `--entrypoint node`, smoke với các giá trị default unset exit **1**, `SERVICE_IDENTITY_SECRET is required.` Đề xuất fail ngay ở config validation/preflight và validate cả format/length trước deploy; không dùng dev secrets trong production.

## Kết quả lệnh và raw logs

Các local commands dưới đây chạy từ workspace, dependencies core đã có sẵn. Local riêng không chứng minh build từ clean install.

| Lệnh | Exit | Bằng chứng |
|---|---|---|
| `pnpm build:all` | 0 | [9/9 build steps](build-deploy-review-2026-10-05-build-all.log) |
| `pnpm build` | 1 | [workspace build](build-deploy-review-2026-10-05-workspace-build.log): LC missing tsc/node_modules |
| `pnpm --filter @du/orchestrator build` | 0 | [log](build-deploy-review-2026-10-05-local-orchestrator.log) |
| `pnpm --filter @du/connector build` | 0 | [log](build-deploy-review-2026-10-05-local-connector.log) |
| `pnpm --filter @du/document-core build` | 0 | [log](build-deploy-review-2026-10-05-local-document-core.log) |
| `pnpm --filter @du/lc-checker build` | 1 | [log](build-deploy-review-2026-10-05-local-lc-checker.log) |
| `pnpm --filter @du/example-review build` | 0 | [log](build-deploy-review-2026-10-05-local-example-review.log) |
| `pnpm --filter @du/admin-web build` | 0 | [log](build-deploy-review-2026-10-05-local-admin-web.log) |
| Original Orchestrator Dockerfile build | 1 | [log](build-deploy-review-2026-10-05-docker-orchestrator.log): pnpm ignored-builds error |
| Original Connector Dockerfile build | 0 | [log](build-deploy-review-2026-10-05-docker-connector.log) |
| Original Document Core Dockerfile build | 0 | [log](build-deploy-review-2026-10-05-docker-document-core.log) |
| Original LC Checker Dockerfile build | 1 | [log](build-deploy-review-2026-10-05-docker-lc-checker.log): TS5058 |
| Original Example Review Dockerfile build | 1 | [log](build-deploy-review-2026-10-05-docker-example-review.log): TS5058 |
| Connector default entrypoint smoke | 255 | [log](build-deploy-review-2026-10-05-connector-default-boot.log): CRLF shell interpreter |
| Connector bypass-entrypoint config smoke | 1 | [log](build-deploy-review-2026-10-05-connector-config-boot.log): required secret |
| Document Core blank optional-env smoke | 1 | [log](build-deploy-review-2026-10-05-document-core-default-boot.log): invalid config |

Docker build command pattern: `docker build --progress plain --tag du-review-<service>:20261005 --file <snapshot>/<services-or-businesses>/<service>/Dockerfile <snapshot>`.

Compose: 8 independent configs checked; **root exit 1, other 7 exit 0**. Probe uses synthetic credentials and an explicit empty env file, never dumps actual `.env` values. Reproduce with `python coordination/reports/build-deploy-review-2026-10-05-compose-probe.py` from workspace. [Probe source](build-deploy-review-2026-10-05-compose-probe.py), [results including port overrides](build-deploy-review-2026-10-05-compose-results.json). Probe process exit 0 means it collected results; individual Compose exit codes are in JSON.

Additional diagnostic only: temporary Orchestrator Dockerfile pinned pnpm 10.18.3 and mounted existing build caches; failed install with registry **ETIMEDOUT**, exit 1 ([log](build-deploy-review-2026-10-05-docker-orchestrator-pin.log)). Product Dockerfile unchanged. This network error is not a compiler finding; no successful Orchestrator image was generated by either attempt.

Không chạy unit/integration/browser tests trong review build/deploy này; không công bố test count. Không verify actual full-stack startup, real DB migration, worker registration/jobs, provider invocation, S3/Vault hoặc deployed login. Full stack deploy bị chặn ngay tại Compose validation; không có verdict release/ACCEPTED.

## Thứ tự sửa đề xuất

1. Sửa root composition, pin build toolchain và làm cold Docker builds của cả 5 services đạt; chuẩn LF entrypoints.
2. Sửa env validation, container/host ports, network worker→Connector, secrets preflight và migration stage.
3. Đóng gói Admin assets, expose shell đúng listener và cấu hình auth/rollout.
4. Hợp nhất local start/stop/watch, giới hạn PID ownership và fail-fast health/migrations.
5. Verify trên project/DB/Redis/Vault/S3 namespace cô lập: từng service → core stack → extension workers → API job + provider + Admin login. Kiểm stop/restart và dữ liệu tồn tại sau restart; không dùng Compose parse/build pass thay live verification.
