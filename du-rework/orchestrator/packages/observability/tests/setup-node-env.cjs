// WFA: pin a hermetic test environment for this package.
// jest only defaults NODE_ENV=test when it is UNSET, so an inherited shell
// NODE_ENV=production (or DU_ENVIRONMENT/APP_ENV) silently reached
// src/logger.ts' resolveEnvironment() and broke the environment-field
// assertions. Runs via setupFiles: before the test framework and before any
// test module loads, so every Logger built in these tests sees 'test'.
process.env.NODE_ENV = 'test';
// The logger prefers DU_ENVIRONMENT/APP_ENV over NODE_ENV; a shell that sets
// them would still win, so neutralize them for the test process.
delete process.env.DU_ENVIRONMENT;
delete process.env.APP_ENV;
