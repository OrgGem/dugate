# Standalone dev runtime verification — 2026-10-13

- `pnpm run build` passed all 9 stages; `pnpm run test:dev` passed 5/5 tests.
- The actual `pnpm run dev` entrypoint started successfully in both `--no-watch` and default watch mode with `--skip-build --mock-vault`. The temporary database migrations completed and then verified up to date on restart.
- Backend health (`17773`, `17774`) and Connector readiness (`18888`) returned 200. In watch mode, the Admin Web login returned 200; an unauthenticated browser-style `/admin/` request returned 302 to `/admin/login`.
- Both owned runner processes were stopped. The temporary PostgreSQL database was dropped, Redis DB 15 remained at 0 keys, and the ignored verification environment and temporary state file were removed. Service listeners were released.
- This check did not run worker or provider end-to-end workflows.
