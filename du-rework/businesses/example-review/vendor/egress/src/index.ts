/**
 * @du/egress — shared pinned egress (PR-Q3-09): one implementation of the
 * DNS-rebinding-safe fetch consumed by services/connector (provider calls, PR-Q3-03)
 * and services/orchestrator (webhook dispatch). Policy tables stay in @du/contracts;
 * this package owns the socket-level enforcement that makes adjudication + connect
 * share ONE resolution.
 */

export * from './pinned-fetch';
