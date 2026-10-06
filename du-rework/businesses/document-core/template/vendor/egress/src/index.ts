// VENDORED from @du/egress @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/egress/src/index.ts (lines=9) sha256=53D74040F273DE966BDF1142D22D372855C19551F8816D82F184E0F6929E1940
// why: egress package for vendored worker-sdk source-acquisition

/**
 * @du/egress — shared pinned egress (PR-Q3-09): one implementation of the
 * DNS-rebinding-safe fetch consumed by services/connector (provider calls, PR-Q3-03)
 * and services/orchestrator (webhook dispatch). Policy tables stay in @du/contracts;
 * this package owns the socket-level enforcement that makes adjudication + connect
 * share ONE resolution.
 */

export * from './pinned-fetch';
