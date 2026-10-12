import { ProviderReportedCostSchema, UsageCostProvenanceSchema, type ProviderReportedCost, type UsageCostProvenance } from '@du/contracts';
import type { CostAdjustmentHistoryPage } from '@du/contracts';

export type UsageCostStatus = 'measured' | 'estimated' | 'unpriced' | 'pending';

export interface UsageSummaryRowView {
  provider: string;
  model: string;
  operations: number;
  inputTokens: number;
  outputTokens: number;
  pages: number;
  costMicrousd: number;
  measurement: 'measured' | 'estimated' | 'mixed' | 'pending';
  costStatus: UsageCostStatus | null;
}

export interface UsageSummaryView {
  rows: UsageSummaryRowView[];
  totals: {
    operations: number;
    inputTokens: number;
    outputTokens: number;
    pages: number;
    costMicrousd: number;
    costStatus: UsageCostStatus | null;
  };
}

export interface AdminUsageEventView {
  eventId: string;
  tenantId: string;
  operationId: string;
  taskId: string;
  invocationId: string;
  provider: string | null;
  model: string | null;
  units: {
    inputTokens: number;
    outputTokens: number;
    pages?: number;
  };
  costMicrousd: number | null;
  costStatus: UsageCostStatus | null;
  financialAccounting: AdminUsageFinancialAccounting | null;
  costProvenance?: UsageCostProvenance;
  providerReportedCost?: ProviderReportedCost;
  measurement: 'measured' | 'estimated';
  occurredAt: string;
  receivedAt: string;
}

export interface AdminUsageFinancialAccounting {
  rootEventId: string;
  initialChargeMicrousd: number | null;
  grossChargeMicrousd: number | null;
  refundedMicrousd: number | null;
  netChargeMicrousd: number | null;
  adjustmentRevision: number;
  headAdjustmentEventId: string | null;
  semantics: 'initial-charge-plus-direct-root-adjustments-v1';
}

export interface AdminUsageEventPageView {
  tenantId: string;
  events: AdminUsageEventView[];
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
  skippedInvalidEvents: number;
  timeSemantics: { field: 'receivedAt'; order: 'asc'; timezone: 'UTC' };
}

export interface UsageFilters {
  from: string;
  to: string;
  provider: string;
  model: string;
  operationId: string;
  limit: '25' | '50' | '100';
}

export interface UsageEventQueryView {
  tenantId: string;
  from: string;
  to: string;
  timeField: 'receivedAt';
  limit: number;
  cursor?: string;
  provider?: string;
  model?: string;
  operationId?: string;
}

export interface UsageFilterValidation {
  from: string | null;
  to: string | null;
  error: string | null;
}

const COST_STATUSES = new Set<UsageCostStatus>(['measured', 'estimated', 'unpriced', 'pending']);
const PROVIDER_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,127}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_LIMIT_MS = 366 * 24 * 60 * 60 * 1000;
const FILTER_QUERY_KEYS = ['from', 'to', 'provider', 'model', 'operationId', 'limit', 'tenantId'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function costStatus(value: unknown): UsageCostStatus | null {
  return typeof value === 'string' && COST_STATUSES.has(value as UsageCostStatus)
    ? value as UsageCostStatus
    : null;
}

function optionalCostStatus(value: unknown): { valid: boolean; status: UsageCostStatus | null } {
  if (value === undefined || value === null) return { valid: true, status: null };
  const parsed = costStatus(value);
  return parsed === null ? { valid: false, status: null } : { valid: true, status: parsed };
}

function parseFinancialAccounting(
  value: unknown,
  eventId: string,
  initialChargeMicrousd: number | null,
): { valid: boolean; accounting: AdminUsageFinancialAccounting | null } {
  // Older server pages may not yet include the accounting envelope. Keep the
  // event readable while leaving every accounting amount explicitly unknown.
  if (value === undefined) return { valid: true, accounting: null };
  if (!isRecord(value)) return { valid: false, accounting: null };
  const rootEventId = text(value['rootEventId']);
  const initial = value['initialChargeMicrousd'] === null ? null : safeCount(value['initialChargeMicrousd']);
  const gross = value['grossChargeMicrousd'] === null ? null : safeCount(value['grossChargeMicrousd']);
  const refunded = value['refundedMicrousd'] === null ? null : safeCount(value['refundedMicrousd']);
  const net = value['netChargeMicrousd'] === null ? null : safeCount(value['netChargeMicrousd']);
  const revision = safeCount(value['adjustmentRevision']);
  const rawHead = value['headAdjustmentEventId'];
  const head = rawHead === null ? null : text(rawHead);
  const semantics = value['semantics'];
  if (
    rootEventId !== eventId || initial === null && value['initialChargeMicrousd'] !== null ||
    gross === null && value['grossChargeMicrousd'] !== null ||
    refunded === null && value['refundedMicrousd'] !== null ||
    net === null && value['netChargeMicrousd'] !== null ||
    initial !== initialChargeMicrousd || revision === null ||
    (rawHead !== null && (head === null || !OPERATION_ID.test(head))) ||
    (revision === 0) !== (head === null) ||
    semantics !== 'initial-charge-plus-direct-root-adjustments-v1'
  ) return { valid: false, accounting: null };
  return {
    valid: true,
    accounting: {
      rootEventId,
      initialChargeMicrousd: initial,
      grossChargeMicrousd: gross,
      refundedMicrousd: refunded,
      netChargeMicrousd: net,
      adjustmentRevision: revision,
      headAdjustmentEventId: head,
      semantics,
    },
  };
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const datePart = value.slice(0, 10);
  const dateStart = Date.parse(`${datePart}T00:00:00Z`);
  return Number.isFinite(Date.parse(value)) && Number.isFinite(dateStart) && new Date(dateStart).toISOString().slice(0, 10) === datePart
    ? value
    : null;
}

/** Strictly project the summary fields used by the operator view. */
export function parseUsageSummary(value: unknown): UsageSummaryView | null {
  if (!isRecord(value) || !isRecord(value['totals']) || !Array.isArray(value['rows'])) return null;
  const totals = value['totals'];
  const operations = safeCount(totals['operations']);
  const inputTokens = safeCount(totals['inputTokens']);
  const outputTokens = safeCount(totals['outputTokens']);
  const pages = safeCount(totals['pages']);
  const costMicrousd = safeCount(totals['costMicrousd']);
  if ([operations, inputTokens, outputTokens, pages, costMicrousd].some((part) => part === null)) return null;

  const rows: UsageSummaryRowView[] = [];
  for (const raw of value['rows']) {
    if (!isRecord(raw)) return null;
    const provider = text(raw['provider']);
    const model = text(raw['model']);
    const rowOperations = safeCount(raw['operations']);
    const rowInput = safeCount(raw['inputTokens']);
    const rowOutput = safeCount(raw['outputTokens']);
    const rowPages = safeCount(raw['pages']);
    const rowCost = safeCount(raw['costMicrousd']);
    const measurement = raw['measurement'];
    const rowStatus = optionalCostStatus(raw['costStatus']);
    if (
      provider === null || model === null || rowOperations === null || rowInput === null ||
      rowOutput === null || rowPages === null || rowCost === null ||
      !rowStatus.valid ||
      !['measured', 'estimated', 'mixed', 'pending'].includes(String(measurement))
    ) return null;
    rows.push({
      provider,
      model,
      operations: rowOperations,
      inputTokens: rowInput,
      outputTokens: rowOutput,
      pages: rowPages,
      costMicrousd: rowCost,
      measurement: measurement as UsageSummaryRowView['measurement'],
      costStatus: rowStatus.status,
    });
  }

  const totalStatus = optionalCostStatus(totals['costStatus']);
  if (!totalStatus.valid) return null;

  return {
    rows,
    totals: {
      operations: operations!,
      inputTokens: inputTokens!,
      outputTokens: outputTokens!,
      pages: pages!,
      costMicrousd: costMicrousd!,
      costStatus: totalStatus.status,
    },
  };
}

/** Runtime-check the BASIC_ADMIN_USAGE_V1 page; never render raw API payloads. */
export function parseAdminUsageEventPage(value: unknown, expectedTenantId: string): AdminUsageEventPageView | null {
  if (!isRecord(value) || value['tenantId'] !== expectedTenantId || !Array.isArray(value['events'])) return null;
  const limit = safeCount(value['limit']);
  const skippedInvalidEvents = safeCount(value['skippedInvalidEvents']);
  const hasMore = value['hasMore'];
  const rawCursor = value['nextCursor'];
  const cursor = rawCursor === undefined ? null : text(rawCursor);
  const semantics = value['timeSemantics'];
  if (
    limit === null || limit < 1 || limit > 100 || skippedInvalidEvents === null ||
    typeof hasMore !== 'boolean' || (rawCursor !== undefined && cursor === null) || (hasMore !== (cursor !== null)) ||
    !isRecord(semantics) || semantics['field'] !== 'receivedAt' || semantics['order'] !== 'asc' || semantics['timezone'] !== 'UTC' ||
    value['events'].length > limit
  ) return null;

  const events: AdminUsageEventView[] = [];
  for (const raw of value['events']) {
    if (!isRecord(raw) || !isRecord(raw['units'])) return null;
    const eventId = text(raw['eventId']);
    const operationId = text(raw['operationId']);
    const taskId = text(raw['taskId']);
    const invocationId = text(raw['invocationId']);
    const inputTokens = safeCount(raw['units']['inputTokens']);
    const outputTokens = safeCount(raw['units']['outputTokens']);
    const rawPages = raw['units']['pages'];
    const pages = rawPages === undefined ? undefined : safeCount(rawPages);
    const cost = raw['costMicrousd'] === null ? null : safeCount(raw['costMicrousd']);
    const measurement = raw['measurement'];
    const rawCostStatus = raw['costStatus'];
    const eventStatus = optionalCostStatus(rawCostStatus);
    const rawProvenance = raw['costProvenance'];
    const parsedProvenance = rawProvenance === undefined || rawProvenance === null
      ? null : UsageCostProvenanceSchema.safeParse(rawProvenance);
    const reportedCost = ProviderReportedCostSchema.safeParse(raw['providerReportedCost']);
    const accounting = parseFinancialAccounting(raw['financialAccounting'], eventId ?? '', cost);
    const occurredAt = timestamp(raw['occurredAt']);
    const receivedAt = timestamp(raw['receivedAt']);
    const provider = raw['provider'] === null ? null : text(raw['provider']);
    const model = raw['model'] === null ? null : text(raw['model']);
    if (
      eventId === null || operationId === null || !OPERATION_ID.test(operationId) || taskId === null || invocationId === null ||
      inputTokens === null || outputTokens === null || (rawPages !== undefined && pages === null) ||
      (raw['costMicrousd'] !== null && cost === null) || !eventStatus.valid || !['measured', 'estimated'].includes(String(measurement)) ||
      occurredAt === null || receivedAt === null || (raw['provider'] !== null && provider === null) ||
      (raw['model'] !== null && model === null) ||
      !accounting.valid ||
      (parsedProvenance !== null && (!parsedProvenance.success || parsedProvenance.data.tenantId !== expectedTenantId))
    ) return null;
    events.push({
      eventId,
      tenantId: expectedTenantId,
      operationId,
      taskId,
      invocationId,
      provider,
      model,
      units: { inputTokens, outputTokens, ...(pages === undefined || pages === null ? {} : { pages }) },
      costMicrousd: cost,
      costStatus: eventStatus.status,
      financialAccounting: accounting.accounting,
      ...(parsedProvenance && parsedProvenance.success ? { costProvenance: parsedProvenance.data } : {}),
      ...(reportedCost.success ? { providerReportedCost: reportedCost.data } : {}),
      measurement: measurement as AdminUsageEventView['measurement'],
      occurredAt,
      receivedAt,
    });
  }
  return {
    tenantId: expectedTenantId,
    events,
    limit,
    hasMore,
    nextCursor: cursor,
    skippedInvalidEvents,
    timeSemantics: { field: 'receivedAt', order: 'asc', timezone: 'UTC' },
  };
}

function utcInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 16) === value
    ? new Date(parsed).toISOString()
    : null;
}

function utcInputFromTimestamp(value: string | null): string | null {
  const valid = timestamp(value);
  if (valid === null) return null;
  return new Date(valid).toISOString().slice(0, 16);
}

export function defaultUsageFilters(now = Date.now()): UsageFilters {
  const to = Math.floor(now / 60_000) * 60_000;
  return {
    from: new Date(to - 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
    to: new Date(to).toISOString().slice(0, 16),
    provider: '',
    model: '',
    operationId: '',
    limit: '50',
  };
}

/** URL values are treated as UTC because the visible fields say so explicitly. */
export function usageFiltersFromSearch(search: string, now = Date.now()): UsageFilters {
  const params = new URLSearchParams(search);
  const defaults = defaultUsageFilters(now);
  const provider = params.get('provider')?.trim() ?? '';
  const model = params.get('model')?.trim() ?? '';
  const operationId = params.get('operationId')?.trim() ?? '';
  const limit = params.get('limit');
  const parsedFrom = utcInputFromTimestamp(params.get('from'));
  const parsedTo = utcInputFromTimestamp(params.get('to'));
  const validProviderModel = provider === '' && model === '' || PROVIDER_MODEL_ID.test(provider) && PROVIDER_MODEL_ID.test(model);
  return {
    from: parsedFrom ?? defaults.from,
    to: parsedTo ?? defaults.to,
    provider: validProviderModel ? provider : '',
    model: validProviderModel ? model : '',
    operationId: operationId === '' || OPERATION_ID.test(operationId) ? operationId : '',
    limit: limit === '25' || limit === '100' ? limit : '50',
  };
}

export function validateUsageFilters(filters: UsageFilters): UsageFilterValidation {
  const from = utcInput(filters.from);
  const to = utcInput(filters.to);
  if (from === null || to === null) return { from, to, error: 'Choose both UTC time bounds.' };
  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  if (fromTime >= toTime) return { from, to, error: 'The start time must be before the end time.' };
  if (toTime - fromTime > TIME_LIMIT_MS) return { from, to, error: 'Choose a window of 366 days or less.' };
  const provider = filters.provider.trim();
  const model = filters.model.trim();
  if ((provider === '') !== (model === '')) return { from, to, error: 'Choose both a provider and model, or leave both blank.' };
  if (provider !== '' && (!PROVIDER_MODEL_ID.test(provider) || !PROVIDER_MODEL_ID.test(model))) {
    return { from, to, error: 'Provider and model must use letters, numbers, or . _ : @ / - (up to 128 characters).' };
  }
  if (filters.operationId.trim() !== '' && !OPERATION_ID.test(filters.operationId.trim())) {
    return { from, to, error: 'Enter a valid operation UUID.' };
  }
  return { from, to, error: null };
}

export function buildUsageEventQuery(
  tenantId: string,
  filters: UsageFilters,
  cursor: string | null,
): UsageEventQueryView {
  const validated = validateUsageFilters(filters);
  if (validated.error !== null || validated.from === null || validated.to === null) {
    return { tenantId, from: '', to: '', timeField: 'receivedAt', limit: Number(filters.limit) };
  }
  const query: UsageEventQueryView = {
    tenantId,
    from: validated.from,
    to: validated.to,
    timeField: 'receivedAt',
    limit: Number(filters.limit),
  };
  if (cursor !== null) query['cursor'] = cursor;
  if (filters.provider.trim() !== '' && filters.model.trim() !== '') {
    query['provider'] = filters.provider.trim();
    query['model'] = filters.model.trim();
  }
  if (filters.operationId.trim() !== '') query['operationId'] = filters.operationId.trim();
  return query;
}

export function usageFiltersToSearch(filters: UsageFilters, currentSearch = ''): string {
  const params = new URLSearchParams(currentSearch);
  for (const key of FILTER_QUERY_KEYS) params.delete(key);
  const validated = validateUsageFilters(filters);
  if (validated.error !== null || validated.from === null || validated.to === null) return params.toString();
  params.set('from', validated.from);
  params.set('to', validated.to);
  if (filters.provider.trim() !== '' && filters.model.trim() !== '') {
    params.set('provider', filters.provider.trim());
    params.set('model', filters.model.trim());
  }
  if (filters.operationId.trim() !== '') params.set('operationId', filters.operationId.trim());
  if (filters.limit !== '50') params.set('limit', filters.limit);
  return params.toString();
}

function csvCell(value: string | number): string {
  const text = String(value);
  const neutralized = /^[\u0000-\u0020]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

/** CSV contains exactly one rendered page and only allowlisted, persisted fields. */
export function buildUsageEventsCsv(events: readonly AdminUsageEventView[], tenantId: string): string {
  const rows = [
    ['tenant_id', 'event_id', 'operation_id', 'task_id', 'invocation_id', 'provider', 'model', 'occurred_at', 'received_at', 'input_tokens', 'output_tokens', 'pages', 'cost_status', 'computed_cost_microusd', 'currency', 'measurement', 'attempt', 'api_key_id', 'profile_id', 'profile_revision', 'business_id', 'business_version', 'action', 'step_key', 'connector_id', 'connector_revision', 'duration_ms', 'reservation_group_id', 'selected_at', 'confidence', 'price_revision', 'cost_bound_capability_id', 'input_upper_bound_tokens', 'output_limit_tokens', 'budget_pins', 'provider_reported_cost_microusd_unverified', 'provider_reported_difference_microusd_unverified', 'financial_root_event_id', 'financial_initial_charge_microusd', 'financial_gross_charge_microusd', 'financial_refunded_microusd', 'financial_net_charge_microusd', 'adjustment_revision', 'head_adjustment_event_id', 'financial_semantics'],
    ...events.map((event) => [
      tenantId,
      event.eventId,
      event.operationId,
      event.taskId,
      event.invocationId,
      event.provider ?? '',
      event.model ?? '',
      event.occurredAt,
      event.receivedAt,
      String(event.units.inputTokens),
      String(event.units.outputTokens),
      String(event.units.pages ?? ''),
      event.costStatus ?? 'unknown',
      event.costMicrousd === null ? 'unknown' : String(event.costMicrousd),
      'USD',
      event.measurement,
      event.costProvenance?.attempt ?? '',
      event.costProvenance?.apiKeyId ?? '',
      event.costProvenance?.profileId ?? '',
      event.costProvenance?.profileRevision ?? '',
      event.costProvenance?.businessId ?? '',
      event.costProvenance?.businessVersion ?? '',
      event.costProvenance?.action ?? '',
      event.costProvenance?.stepKey ?? '',
      event.costProvenance?.connectorId ?? '',
      event.costProvenance?.connectorRevision ?? '',
      event.costProvenance?.durationMs ?? '',
      event.costProvenance?.reservationGroupId ?? '',
      event.costProvenance?.selectedAt ?? '',
      event.costProvenance?.confidence ?? '',
      event.costProvenance?.priceRevision ?? '',
      event.costProvenance?.costBoundCapabilityId ?? '',
      event.costProvenance?.inputUpperBoundTokens ?? '',
      event.costProvenance?.outputLimitTokens ?? '',
      event.costProvenance ? JSON.stringify(event.costProvenance.budgetPins) : '',
      event.providerReportedCost?.costMicrousd ?? '',
      event.providerReportedCost && event.costMicrousd !== null ? Math.abs(event.providerReportedCost.costMicrousd - event.costMicrousd) : '',
      event.financialAccounting?.rootEventId ?? 'unknown',
      event.financialAccounting?.initialChargeMicrousd === null || !event.financialAccounting ? 'unknown' : String(event.financialAccounting.initialChargeMicrousd),
      event.financialAccounting?.grossChargeMicrousd === null || !event.financialAccounting ? 'unknown' : String(event.financialAccounting.grossChargeMicrousd),
      event.financialAccounting?.refundedMicrousd === null || !event.financialAccounting ? 'unknown' : String(event.financialAccounting.refundedMicrousd),
      event.financialAccounting?.netChargeMicrousd === null || !event.financialAccounting ? 'unknown' : String(event.financialAccounting.netChargeMicrousd),
      event.financialAccounting?.adjustmentRevision ?? 'unknown',
      event.financialAccounting?.headAdjustmentEventId ?? '',
      event.financialAccounting?.semantics ?? 'unknown',
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Export only the server-returned bounded history page; no client-side ledger reconstruction. */
export function buildCostAdjustmentHistoryCsv(page: CostAdjustmentHistoryPage): string {
  const rows = [
    ['tenant_id', 'root_event_id', 'root_eligible', 'eligibility_blockers', 'adjustment_revision_head', 'head_adjustment_event_id', 'initial_charge_microusd', 'gross_charge_microusd', 'refunded_microusd', 'net_charge_microusd', 'semantics', 'adjustment_event_id', 'adjustment_revision', 'previous_adjustment_event_id', 'kind', 'target_charge_microusd', 'refund_microusd', 'effective_at_original_event_utc', 'recorded_at_utc', 'authority', 'actor_kind', 'actor_principal_id', 'evidence_artifact_id', 'evidence_storage_generation_id', 'evidence_sha256', 'evidence_size_bytes', 'evidence_object_proof_complete', 'evidence_object_version_id', 'evidence_object_size_bytes', 'evidence_object_sha256', 'evidence_sidecar_version_id', 'evidence_sidecar_size_bytes', 'evidence_sidecar_sha256', 'quota_window_pins', 'reason'],
    ...page.items.map((item) => [
      page.tenantId,
      page.rootEventId,
      page.eligible ? 'true' : 'false',
      JSON.stringify(page.blockers),
      page.adjustmentRevision,
      page.headAdjustmentEventId ?? '',
      page.initialChargeMicrousd === null ? 'unknown' : String(page.initialChargeMicrousd),
      page.grossChargeMicrousd === null ? 'unknown' : String(page.grossChargeMicrousd),
      page.refundedMicrousd === null ? 'unknown' : String(page.refundedMicrousd),
      page.netChargeMicrousd === null ? 'unknown' : String(page.netChargeMicrousd),
      'initial-charge-plus-direct-root-adjustments-v1',
      item.adjustmentEventId,
      item.adjustmentRevision,
      item.previousAdjustmentEventId ?? '',
      item.kind,
      item.targetChargeMicrousd === null ? '' : String(item.targetChargeMicrousd),
      item.refundMicrousd === null ? '' : String(item.refundMicrousd),
      item.effectiveAt,
      item.recordedAt,
      item.authority,
      item.actorKind,
      item.actorPrincipalId,
      item.evidenceArtifactId,
      item.evidenceStorageGenerationId,
      item.evidenceSha256,
      item.evidenceSizeBytes,
      item.evidenceObjectProofComplete ? 'complete' : 'incomplete',
      item.evidenceObjectVersionId,
      item.evidenceObjectSizeBytes === null ? 'unknown' : String(item.evidenceObjectSizeBytes),
      item.evidenceObjectSha256 ?? 'unknown',
      item.evidenceSidecarVersionId,
      item.evidenceSidecarSizeBytes,
      item.evidenceSidecarSha256,
      JSON.stringify(item.quotaWindowPins.map((pin) => ({
        budgetId: pin.budgetId,
        budgetRevision: pin.budgetRevision,
        period: pin.period,
        windowStart: pin.windowStart,
        windowEnd: pin.windowEnd,
      }))),
      item.reason,
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function costStatusLabel(status: UsageCostStatus | null): string {
  switch (status) {
    case 'measured': return 'Computed from measured units';
    case 'estimated': return 'Estimated';
    case 'pending': return 'Pending';
    case 'unpriced': return 'Unpriced';
    default: return 'Status unavailable';
  }
}

export function formatUsageCost(microusd: number | null, status: UsageCostStatus | null): string {
  if (microusd === null) return status === 'unpriced' ? 'Unpriced · amount unavailable' : 'Cost unavailable';
  const amount = `${(microusd / 1_000_000).toFixed(6)} USD`;
  if (status === 'unpriced') return `Unpriced · ${amount} known`;
  if (status === 'pending') return `Pending · ${amount} known`;
  if (status === 'estimated') return `Estimated · ${amount}`;
  if (status === 'measured') return `Computed · ${amount}`;
  return `Computed amount · ${amount}; status unavailable`;
}

export function usageMeasurementLabel(value: UsageSummaryRowView['measurement']): string {
  switch (value) {
    case 'measured': return 'Measured units';
    case 'estimated': return 'Estimated units';
    case 'mixed': return 'Mixed units';
    case 'pending': return 'Units pending';
  }
}

/** A response is current only for the same tenant/query and refresh cycle. */
export function usageRequestIsCurrent(
  requestScope: string | null,
  requestToken: string | null,
  currentScope: string | null,
  currentToken: string | null,
): boolean {
  return requestScope !== null && requestToken !== null && requestScope === currentScope && requestToken === currentToken;
}
