/**
 * Type definitions for @du/example-review (P7-01/P7-02).
 * Imports only public contracts and worker-sdk interfaces.
 */

export interface ReviewArtifactRef {
  artifactId: string;
  fileName?: string;
}

export interface ReviewInput {
  reviewId: string;
  artifacts: ReviewArtifactRef[];
  checks?: Record<string, boolean>;
  requireApproval?: boolean;
  enableReasoning?: boolean;
}

export interface ChildReviewInput {
  reviewId: string;
  itemIndex: number;
  artifact: ReviewArtifactRef;
  checks?: Record<string, boolean>;
  enableReasoning?: boolean;
}

export interface ItemReviewResult {
  reviewId: string;
  itemIndex: number;
  artifactId: string;
  fileName?: string;
  passed: boolean;
  failedChecks: string[];
  reasoning?: string;
  itemArtifactRef?: string;
  reviewedAt: string;
}

export interface ApprovalDecision {
  approved: boolean;
  note?: string;
  approver?: string;
  decidedAt?: string;
}

export interface AggregateReviewOutput {
  reviewId: string;
  approved: boolean;
  itemCount: number;
  reviewsRef: string;
  failedChecks: string[];
  items: ItemReviewResult[];
  approval?: ApprovalDecision;
  summary: string;
  version?: string;
}
