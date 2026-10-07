/**
 * PR-Q3-09 (cycle 88): implementation MOVED VERBATIM to the shared @du/egress package
 * (packages/egress/src/pinned-fetch.ts) so the orchestrator webhook dispatcher can pin
 * egress with the SAME code instead of a second copy. This shim keeps existing imports
 * (transport.ts, tests) source-compatible; new consumers should import '@du/egress'.
 * Drift risk is now structurally zero: one file owns the socket policy path.
 */
export * from '@du/egress';
