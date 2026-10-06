/**
 * P9-01 disbursement — public surface.
 *
 * Registration note: this module is NOT wired into the document-core manifest or
 * recipe registry. Those files belong to another lane's lease, so the wiring is listed
 * as a follow-up in the P9-01 report rather than edited here.
 */

export * from './primitives';
export * from './types';
export * from './fanout';
export * from './disbursement';