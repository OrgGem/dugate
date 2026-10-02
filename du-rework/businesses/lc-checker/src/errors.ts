export type LcCheckerErrorCode =
  | 'INPUT_INVALID'
  | 'IDENTITY_FIELD_REJECTED'
  | 'RULESET_UNKNOWN'
  | 'ALL_CHILDREN_FAILED'
  | 'CHILD_RESULT_INCOMPLETE'
  | 'CHILD_RESULT_MISMATCH'
  | 'COMPLIANCE_INVALID'
  | 'PORT_MISCONFIGURED';

export class LcCheckerError extends Error {
  public readonly code: LcCheckerErrorCode;
  public readonly retryable: boolean;

  constructor(code: LcCheckerErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'LcCheckerError';
    this.code = code;
    this.retryable = retryable;
  }
}
