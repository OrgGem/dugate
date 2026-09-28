import {
  BudgetConfigSchema,
  BudgetEvaluationSchema,
  UsageSummarySchema,
  evaluateBudgetStatus,
} from '@du/contracts';
import type { BudgetConfigInput, BudgetEvaluation, UsageSummary } from '@du/contracts';
import { HttpError, zodIssuesToProblem } from '../../http/errors';

/** Validate a tenant-scoped budget and its usage inputs before exposing a
 * budget verdict from the Orchestrator summary path. This summary currently
 * aggregates tenant-wide usage only, so narrower configured scopes fail
 * closed until the query can apply the same dimensions. */
export function validateBudgetEvaluation(input: {
  tenantId: string;
  budget: BudgetConfigInput;
  usage: UsageSummary;
  inFlightReservation?: UsageSummary;
}): BudgetEvaluation {
  const parsedBudget = BudgetConfigSchema.safeParse(input.budget);
  if (!parsedBudget.success) {
    throw zodIssuesToProblem(parsedBudget.error.issues);
  }
  if (parsedBudget.data.tenantId !== input.tenantId) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'budget must belong to the requested tenant');
  }
  if (
    parsedBudget.data.apiKeyId !== undefined ||
    parsedBudget.data.profileId !== undefined ||
    parsedBudget.data.businessId !== undefined
  ) {
    throw new HttpError(
      422,
      'BUDGET_SCOPE_UNSUPPORTED',
      'the current usage summary cannot evaluate apiKey, profile, or business scoped budgets',
    );
  }

  const usage = UsageSummarySchema.safeParse(input.usage);
  if (!usage.success) {
    throw zodIssuesToProblem(usage.error.issues);
  }
  const reservation =
    input.inFlightReservation === undefined
      ? undefined
      : UsageSummarySchema.safeParse(input.inFlightReservation);
  if (reservation !== undefined && !reservation.success) {
    throw zodIssuesToProblem(reservation.error.issues);
  }

  const evaluation = evaluateBudgetStatus(
    parsedBudget.data,
    usage.data,
    reservation === undefined ? undefined : reservation.data,
  );
  return BudgetEvaluationSchema.parse(evaluation);
}
