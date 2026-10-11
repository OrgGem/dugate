// GROUP A pin: a hermetic test environment for the orchestrator service.
// Mirrors packages/observability/tests/setup-node-env.cjs (same three lines,
// same reason) — do not reinvent the logic.
//
// jest only defaults NODE_ENV=test when it is UNSET, so an inherited shell
// NODE_ENV=production silently reaches production-only guards and breaks 34
// tests in four offline suites: src/main.ts:135 throws
// ORCHESTRATOR_INTERNAL_BASE_URL is required…, the admin shell refuses to mint
// a cookie over unproven TLS (auth-dispatch.ts:120-130 -> POST /admin/login
// answers 503 instead of 302), and the structured logger stamps
// environment:"prod" where the suites assert "test".
//
// Runs via setupFiles: before the test framework and before any test module
// loads, so every module built in these tests sees 'test'. A suite that needs
// production behaviour still sets it explicitly (e.g.
// tests/v1-boot-typed-denial.test.ts:268) and that override keeps working.
process.env.NODE_ENV = 'test';
// The environment resolver prefers DU_ENVIRONMENT/APP_ENV over NODE_ENV; a
// shell that sets them would still win, so neutralize them for the test process.
delete process.env.DU_ENVIRONMENT;
delete process.env.APP_ENV;
