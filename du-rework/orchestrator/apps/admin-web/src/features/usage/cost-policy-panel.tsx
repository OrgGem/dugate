import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  BudgetConfigSchema,
  ModelPricingTableSchema,
  type BudgetConfig,
  type CostAlertChannelList,
  type CostAlertRecipient,
  type CostControlBudgetDetail,
  type CostControlBudgetList,
  type CostControlPriceList,
  type CostBudgetAlertBinding,
  type CostPolicyScopeCatalog,
  type CostPolicyScopeApiKey,
  type CostPolicyScopeBusiness,
  type CostPolicyScopeProfile,
  type ModelPricingTier,
  type PersistedBudgetRevision,
  type PersistedPriceRevision,
} from '@du/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { createAdminApiClient, type AdminApiClient, type AdminApiProblem, type AdminWebSession } from '@/lib/api';

type DataState<T> = { kind: 'loading' } | { kind: 'failed'; problem: AdminApiProblem } | { kind: 'ready'; data: T };
type ApiKeyScopePage = Extract<CostPolicyScopeCatalog, { kind: 'api-keys' }>;
type ProfileScopePage = Extract<CostPolicyScopeCatalog, { kind: 'profiles' }>;
type BusinessScopePage = Extract<CostPolicyScopeCatalog, { kind: 'businesses' }>;
type ScopeOptions = { apiKeys: CostPolicyScopeApiKey[]; profiles: CostPolicyScopeProfile[]; businesses: CostPolicyScopeBusiness[] };
type OwnerSelection = '' | `local:${string}` | `oidc:${string}`;
type BudgetForm = {
  period: 'daily' | 'monthly';
  tokenThreshold: string;
  usdThreshold: string;
  alertThresholdPercent: string;
  policy: 'alert-only' | 'block-new-invocations';
  status: 'active' | 'suspended';
  apiKeyId: string;
  profileId: string;
  businessId: string;
  channelIds: string[];
};
type PriceTierForm = {
  provider: string;
  modelId: string;
  priceVersion: string;
  effectiveFrom: string;
  effectiveTo: string;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  cachedInputUsdPerMillion: string;
  pageUsdPerPage: string;
};

function freshIdempotencyKey(prefix: string): string { return `${prefix}:${crypto.randomUUID()}`; }
function ownerSelectionFromBinding(owner: CostBudgetAlertBinding['owner'] | undefined): OwnerSelection {
  if (!owner) return '';
  return 'kind' in owner ? `oidc:${owner.principalId}` : `local:${owner.userId}`;
}
function problemText(problem: AdminApiProblem): string { return problem.title ?? problem.code ?? 'Request failed.'; }
function selectedRevision(detail: CostControlBudgetDetail | null): PersistedBudgetRevision | null {
  return detail?.revisions.find((revision) => revision.revision === detail.headRevision) ?? null;
}
function emptyBudgetForm(): BudgetForm {
  return { period: 'monthly', tokenThreshold: '100000', usdThreshold: '1000', alertThresholdPercent: '80', policy: 'alert-only', status: 'active', apiKeyId: '', profileId: '', businessId: '', channelIds: [] };
}
function usdFromMicroUsd(value: number): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
function microUsdFromUsd(value: string): number | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole = '', fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}
function budgetFormFrom(config: BudgetConfig): BudgetForm {
  return {
    period: config.period,
    tokenThreshold: String(config.tokenThreshold),
    usdThreshold: usdFromMicroUsd(config.usdThresholdMicroUsd),
    alertThresholdPercent: String(config.alertThresholdPercent),
    policy: config.policy,
    status: config.status,
    apiKeyId: config.apiKeyId ?? '',
    profileId: config.profileId ?? '',
    businessId: config.businessId ?? '',
    channelIds: [...config.notificationChannels],
  };
}
function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function isoFromUtcInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 16) === value ? new Date(parsed).toISOString() : null;
}
function utcInput(value: string | undefined): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 16) : '';
}
function toPriceTierForm(tier: ModelPricingTier): PriceTierForm {
  return {
    provider: tier.provider ?? '',
    modelId: tier.modelId,
    priceVersion: String(tier.priceVersion),
    effectiveFrom: utcInput(tier.effectiveFrom),
    effectiveTo: utcInput(tier.effectiveTo),
    inputUsdPerMillion: usdFromMicroUsd(tier.inputMicrousdPerMillion),
    outputUsdPerMillion: usdFromMicroUsd(tier.outputMicrousdPerMillion),
    cachedInputUsdPerMillion: tier.cachedInputMicrousdPerMillion === undefined ? '' : usdFromMicroUsd(tier.cachedInputMicrousdPerMillion),
    pageUsdPerPage: tier.pageMicrousdPerPage === undefined ? '' : usdFromMicroUsd(tier.pageMicrousdPerPage),
  };
}
function defaultPriceTier(): PriceTierForm {
  const now = new Date();
  return {
    provider: '', modelId: '', priceVersion: '1', effectiveFrom: now.toISOString().slice(0, 16), effectiveTo: '',
    inputUsdPerMillion: '0', outputUsdPerMillion: '0', cachedInputUsdPerMillion: '', pageUsdPerPage: '',
  };
}
function priceTableFromForms(forms: PriceTierForm[]): { tiers: ModelPricingTier[] | null; error: string | null } {
  const rows: unknown[] = [];
  for (const [index, form] of forms.entries()) {
    const priceVersion = parsePositiveInteger(form.priceVersion);
    const effectiveFrom = isoFromUtcInput(form.effectiveFrom);
    const inputMicrousdPerMillion = microUsdFromUsd(form.inputUsdPerMillion);
    const outputMicrousdPerMillion = microUsdFromUsd(form.outputUsdPerMillion);
    const cached = form.cachedInputUsdPerMillion === '' ? null : microUsdFromUsd(form.cachedInputUsdPerMillion);
    const page = form.pageUsdPerPage === '' ? null : microUsdFromUsd(form.pageUsdPerPage);
    if (priceVersion === null || effectiveFrom === null || inputMicrousdPerMillion === null || outputMicrousdPerMillion === null
      || (form.cachedInputUsdPerMillion !== '' && cached === null) || (form.pageUsdPerPage !== '' && page === null)) {
      return { tiers: null, error: `Enter valid USD prices (up to 6 decimal places), a positive price version, and a valid UTC start time in row ${index + 1}.` };
    }
    const effectiveTo = form.effectiveTo === '' ? null : isoFromUtcInput(form.effectiveTo);
    if (form.effectiveTo !== '' && effectiveTo === null) return { tiers: null, error: `Enter a valid UTC end time in row ${index + 1}.` };
    rows.push({
      ...(form.provider.trim() ? { provider: form.provider.trim() } : {}),
      modelId: form.modelId.trim(),
      priceVersion,
      effectiveFrom,
      ...(effectiveTo ? { effectiveTo } : {}),
      currency: 'USD',
      inputMicrousdPerMillion,
      outputMicrousdPerMillion,
      ...(cached === null ? {} : { cachedInputMicrousdPerMillion: cached }),
      ...(page === null ? {} : { pageMicrousdPerPage: page }),
    });
  }
  const parsed = ModelPricingTableSchema.safeParse(rows);
  if (!parsed.success) return { tiers: null, error: parsed.error.issues[0]?.message ?? 'Price rows are invalid or overlap.' };
  return { tiers: parsed.data, error: null };
}
function tierKey(tier: ModelPricingTier): string {
  return [tier.provider ?? '', tier.modelId, tier.priceVersion, tier.effectiveFrom, tier.effectiveTo ?? '', tier.inputMicrousdPerMillion, tier.outputMicrousdPerMillion, tier.cachedInputMicrousdPerMillion ?? '', tier.pageMicrousdPerPage ?? ''].join('|');
}
function diffPriceTiers(before: ModelPricingTier[], after: ModelPricingTier[]): string {
  const oldKeys = new Set(before.map(tierKey));
  const newKeys = new Set(after.map(tierKey));
  const added = [...newKeys].filter((key) => !oldKeys.has(key)).length;
  const removed = [...oldKeys].filter((key) => !newKeys.has(key)).length;
  return `${added} tier${added === 1 ? '' : 's'} added · ${removed} tier${removed === 1 ? '' : 's'} removed · ${after.length} total`;
}

async function loadIdentityAdmins(client: AdminApiClient, tenantId: string): Promise<Array<{ id: string; username: string }>> {
  const result: Array<{ id: string; username: string }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const response = await client.searchAssignableIdentityUsers({ tenantId, limit: '100', ...(cursor ? { cursor } : {}) });
    if (!response.ok) throw response.problem;
    result.push(...response.data.items.filter((row) => row.role === 'ADMIN').map((row) => ({ id: row.id, username: row.username })));
    if (!response.data.nextCursor) return result;
    cursor = response.data.nextCursor;
  }
  throw { status: 422, code: 'IDENTITY_CATALOG_TOO_LARGE', title: 'The tenant Admin roster is too large for one guided owner selector.' } satisfies AdminApiProblem;
}

function buildBudgetConfig(tenantId: string, form: BudgetForm): { config: BudgetConfig | null; error: string | null } {
  const tokenThreshold = parsePositiveInteger(form.tokenThreshold);
  const usdThresholdMicroUsd = microUsdFromUsd(form.usdThreshold);
  const alertThresholdPercent = parsePositiveInteger(form.alertThresholdPercent);
  if (tokenThreshold === null || usdThresholdMicroUsd === null || usdThresholdMicroUsd < 1
    || alertThresholdPercent === null || alertThresholdPercent > 100) {
    return { config: null, error: 'Token limit must be a positive whole number; USD limit must be positive with at most 6 decimals; warning threshold must be 1–100%.' };
  }
  const parsed = BudgetConfigSchema.safeParse({
    tenantId,
    ...(form.apiKeyId ? { apiKeyId: form.apiKeyId } : {}),
    ...(form.profileId ? { profileId: form.profileId } : {}),
    ...(form.businessId ? { businessId: form.businessId } : {}),
    period: form.period,
    tokenThreshold,
    usdThresholdMicroUsd,
    alertThresholdPercent,
    policy: form.policy,
    status: form.status,
    notificationChannels: form.channelIds,
  });
  return parsed.success ? { config: parsed.data, error: null } : { config: null, error: parsed.error.issues[0]?.message ?? 'Budget policy is invalid.' };
}

function budgetDiff(before: BudgetConfig | null, after: BudgetConfig, catalog: ScopeOptions | null, channelCatalog: CostAlertChannelList | null): string[] {
  if (!before) return ['New tenant budget policy'];
  const label = (value: string | undefined, options: Array<{ id: string; label: string }>) =>
    value ? options.find((option) => option.id === value)?.label ?? 'Unavailable selection' : 'All';
  const changes: string[] = [];
  if (before.period !== after.period) changes.push(`Window: ${before.period} → ${after.period}`);
  if (before.tokenThreshold !== after.tokenThreshold) changes.push(`Token limit: ${before.tokenThreshold.toLocaleString()} → ${after.tokenThreshold.toLocaleString()}`);
  if (before.usdThresholdMicroUsd !== after.usdThresholdMicroUsd) changes.push(`Spend limit: $${usdFromMicroUsd(before.usdThresholdMicroUsd)} → $${usdFromMicroUsd(after.usdThresholdMicroUsd)} USD`);
  if (before.alertThresholdPercent !== after.alertThresholdPercent) changes.push(`Warning threshold: ${before.alertThresholdPercent}% → ${after.alertThresholdPercent}%`);
  if (before.policy !== after.policy) changes.push(`Enforcement: ${before.policy} → ${after.policy}`);
  if (before.status !== after.status) changes.push(`Status: ${before.status} → ${after.status}`);
  if (before.apiKeyId !== after.apiKeyId) changes.push(`API key scope: ${label(before.apiKeyId, catalog?.apiKeys ?? [])} → ${label(after.apiKeyId, catalog?.apiKeys ?? [])}`);
  if (before.profileId !== after.profileId) {
    const profiles = (catalog?.profiles ?? []).map((profile) => ({ id: profile.id, label: `${profile.profileName} · ${profile.businessId} ${profile.businessVersion}` }));
    changes.push(`Profile scope: ${label(before.profileId, profiles)} → ${label(after.profileId, profiles)}`);
  }
  if (before.businessId !== after.businessId) changes.push(`Business scope: ${label(before.businessId, catalog?.businesses ?? [])} → ${label(after.businessId, catalog?.businesses ?? [])}`);
  if ([...before.notificationChannels].sort().join(',') !== [...after.notificationChannels].sort().join(',')) {
    const names = (ids: readonly string[]) => ids.length === 0 ? 'None' : ids.map((id) =>
      channelCatalog?.channels.find((channel) => channel.channelId === id)?.displayName ?? `Unavailable channel (${id})`,
    ).join(', ');
    changes.push(`Alert channels: ${names(before.notificationChannels)} → ${names(after.notificationChannels)}`);
  }
  return changes.length ? changes : ['No changes from the current head'];
}

export function CostPolicyPanel({ tenantId, session }: { tenantId: string; session: AdminWebSession }) {
  const client = useMemo(() => createAdminApiClient(), []);
  const [reload, setReload] = useState(0);
  const [budgets, setBudgets] = useState<DataState<CostControlBudgetList>>({ kind: 'loading' });
  const [channels, setChannels] = useState<DataState<CostAlertChannelList>>({ kind: 'loading' });
  const [apiKeyCatalog, setApiKeyCatalog] = useState<DataState<ApiKeyScopePage>>({ kind: 'loading' });
  const [profileCatalog, setProfileCatalog] = useState<DataState<ProfileScopePage>>({ kind: 'loading' });
  const [businessCatalog, setBusinessCatalog] = useState<DataState<BusinessScopePage>>({ kind: 'loading' });
  const [apiKeySearch, setApiKeySearch] = useState('');
  const [profileSearch, setProfileSearch] = useState('');
  const [businessSearch, setBusinessSearch] = useState('');
  const [selectedApiKey, setSelectedApiKey] = useState<CostPolicyScopeApiKey | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<CostPolicyScopeProfile | null>(null);
  const [selectedBusiness, setSelectedBusiness] = useState<CostPolicyScopeBusiness | null>(null);
  const [loadingMoreScope, setLoadingMoreScope] = useState({ apiKeys: false, profiles: false, businesses: false });
  const apiKeyCatalogGeneration = useRef(0);
  const profileCatalogGeneration = useRef(0);
  const businessCatalogGeneration = useRef(0);
  const recipientCatalogGeneration = useRef(0);
  const [admins, setAdmins] = useState<DataState<Array<{ id: string; username: string }>>>({ kind: 'loading' });
  const [oidcRecipients, setOidcRecipients] = useState<DataState<CostAlertRecipient[]>>({ kind: 'loading' });
  const [oidcRecipientCursor, setOidcRecipientCursor] = useState<string | null>(null);
  const [oidcRecipientHasMore, setOidcRecipientHasMore] = useState(false);
  const [oidcRecipientSearch, setOidcRecipientSearch] = useState('');
  const [oidcRecipientLoadingMore, setOidcRecipientLoadingMore] = useState(false);
  const [oidcRecipientReason, setOidcRecipientReason] = useState('');
  const [oidcRecipientLifecycleBusy, setOidcRecipientLifecycleBusy] = useState<string | null>(null);
  const [oidcRecipientLifecycleError, setOidcRecipientLifecycleError] = useState<string | null>(null);
  const [oidcRecipientLifecycleMessage, setOidcRecipientLifecycleMessage] = useState<string | null>(null);
  const [oidcRecipientRegistrationBusy, setOidcRecipientRegistrationBusy] = useState(false);
  const [prices, setPrices] = useState<DataState<CostControlPriceList> | null>(null);
  const [selectedBudgetId, setSelectedBudgetId] = useState('new');
  const [detail, setDetail] = useState<CostControlBudgetDetail | null>(null);
  const [detailProblem, setDetailProblem] = useState<AdminApiProblem | null>(null);
  const [form, setForm] = useState<BudgetForm>(() => emptyBudgetForm());
  const [binding, setBinding] = useState<DataState<CostBudgetAlertBinding | null>>({ kind: 'loading' });
  const [ownerSelection, setOwnerSelection] = useState<OwnerSelection>('');
  const [budgetBusy, setBudgetBusy] = useState(false);
  const [budgetMessage, setBudgetMessage] = useState<string | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [policyReason, setPolicyReason] = useState('');
  const [rollbackSource, setRollbackSource] = useState('');
  const [bindingBusy, setBindingBusy] = useState(false);
  const [bindingMessage, setBindingMessage] = useState<string | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const canReadPolicy = !session.localUser && session.role !== 'viewer';
  const canManagePrices = canReadPolicy && session.role === 'admin' && session.principal.kind === 'platform';
  const canBrowseOidcRecipients = session.plane === 'oidc' && session.role === 'admin' && session.principal.kind === 'platform';
  const newBudget = selectedBudgetId === 'new';
  const latestBudget = selectedRevision(detail);
  const activeBudgetRevision = detail?.activeRevision === null || detail?.activeRevision === undefined
    ? null : detail.revisions.find((revision) => revision.revision === detail.activeRevision) ?? null;
  const activeChannelIds = activeBudgetRevision?.config.notificationChannels ?? [];
  const budgetPreview = buildBudgetConfig(tenantId, form);
  const scopeOptions = useMemo<ScopeOptions>(() => ({
    apiKeys: uniqueScopeItems(apiKeyCatalog.kind === 'ready' ? apiKeyCatalog.data.items : [], selectedApiKey, (item) => item.id),
    profiles: uniqueScopeItems(profileCatalog.kind === 'ready' ? profileCatalog.data.items : [], selectedProfile, (item) => `${item.apiKeyId}:${item.id}`),
    businesses: uniqueScopeItems(businessCatalog.kind === 'ready' ? businessCatalog.data.items : [], selectedBusiness, (item) => item.id),
  }), [apiKeyCatalog, profileCatalog, businessCatalog, selectedApiKey, selectedProfile, selectedBusiness]);
  const draftDiff = budgetPreview.config
    ? budgetDiff(
      latestBudget?.config ?? null,
      budgetPreview.config,
      scopeOptions,
      channels.kind === 'ready' ? channels.data : null,
    )
    : [budgetPreview.error ?? 'Complete the budget fields to preview the draft.'];
  const currentBindingOwner = binding.kind === 'ready' ? binding.data?.owner : undefined;
  const selectedLocalOwnerId = ownerSelection.startsWith('local:') ? ownerSelection.slice('local:'.length) : null;
  const selectedOidcPrincipalId = ownerSelection.startsWith('oidc:') ? ownerSelection.slice('oidc:'.length) : null;
  const selectedOwnerIsAvailable = selectedLocalOwnerId
    ? (admins.kind === 'ready' && admins.data.some((admin) => admin.id === selectedLocalOwnerId))
      || (currentBindingOwner && !('kind' in currentBindingOwner) && currentBindingOwner.userId === selectedLocalOwnerId && currentBindingOwner.enabled && !currentBindingOwner.locked)
    : selectedOidcPrincipalId
      ? (oidcRecipients.kind === 'ready' && oidcRecipients.data.some((recipient) => recipient.principalId === selectedOidcPrincipalId && recipient.eligible))
        || (currentBindingOwner && 'kind' in currentBindingOwner && currentBindingOwner.principalId === selectedOidcPrincipalId && currentBindingOwner.enabled)
      : false;
  const localBindingOwnerMissing = currentBindingOwner && !('kind' in currentBindingOwner)
    && (admins.kind !== 'ready' || !admins.data.some((admin) => admin.id === currentBindingOwner.userId));
  const oidcBindingOwnerMissing = currentBindingOwner && 'kind' in currentBindingOwner
    && (oidcRecipients.kind !== 'ready' || !oidcRecipients.data.some((recipient) => recipient.principalId === currentBindingOwner.principalId));

  useEffect(() => {
    let active = true;
    if (!canReadPolicy) {
      setBudgets({ kind: 'failed', problem: { status: 403, code: 'PERMISSION_DENIED', title: 'Cost policy is available to tenant and platform Admins.' } });
      return () => { active = false; };
    }
    setBudgets({ kind: 'loading' });
    setChannels({ kind: 'loading' });
    setAdmins({ kind: 'loading' });
    if (canManagePrices) setPrices({ kind: 'loading' });
    void Promise.all([
      client.listCostBudgets(tenantId),
      client.listCostAlertChannels(tenantId),
      loadIdentityAdmins(client, tenantId),
      canManagePrices ? client.getCostPrices() : Promise.resolve(null),
    ]).then(([budgetResult, channelResult, adminRows, priceResult]) => {
      if (!active) return;
      if (budgetResult.ok) {
        setBudgets({ kind: 'ready', data: budgetResult.data });
        setSelectedBudgetId((current) => current === 'new' || budgetResult.data.budgets.some((row) => row.budgetId === current)
          ? current : budgetResult.data.budgets[0]?.budgetId ?? 'new');
      } else setBudgets({ kind: 'failed', problem: budgetResult.problem });
      if (channelResult.ok) setChannels({ kind: 'ready', data: channelResult.data });
      else setChannels({ kind: 'failed', problem: channelResult.problem });
      setAdmins({ kind: 'ready', data: adminRows });
      if (canManagePrices && priceResult) {
        if (priceResult.ok) setPrices({ kind: 'ready', data: priceResult.data });
        else setPrices({ kind: 'failed', problem: priceResult.problem });
      }
    }).catch((error: unknown) => {
      if (!active) return;
      const problem = isAdminApiProblem(error) ? error : { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'Cost policy catalogs could not be reached.' };
      setAdmins({ kind: 'failed', problem });
    });
    return () => { active = false; };
  }, [client, tenantId, canReadPolicy, canManagePrices, reload]);

  useEffect(() => {
    const generation = ++recipientCatalogGeneration.current;
    if (!canReadPolicy || !canBrowseOidcRecipients) {
      setOidcRecipients({ kind: 'ready', data: [] });
      setOidcRecipientCursor(null);
      setOidcRecipientHasMore(false);
      return;
    }
    setOidcRecipients({ kind: 'loading' });
    setOidcRecipientCursor(null);
    setOidcRecipientHasMore(false);
    const timer = setTimeout(() => {
      void client.listCostAlertRecipients({ tenantId, q: oidcRecipientSearch, limit: 50 }).then((result) => {
        if (generation !== recipientCatalogGeneration.current) return;
        if (!result.ok) { setOidcRecipients({ kind: 'failed', problem: result.problem }); return; }
        if (result.data.tenantId !== tenantId) {
          setOidcRecipients({ kind: 'failed', problem: { status: 502, code: 'INVALID_RESPONSE', title: 'Recipient catalog returned a different tenant.' } });
          return;
        }
        setOidcRecipients({ kind: 'ready', data: result.data.items });
        setOidcRecipientCursor(result.data.nextCursor);
        setOidcRecipientHasMore(result.data.hasMore);
      }).catch((error: unknown) => {
        if (generation === recipientCatalogGeneration.current) setOidcRecipients({ kind: 'failed', problem: isAdminApiProblem(error) ? error : { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'OIDC recipient catalog could not be reached.' } });
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [client, tenantId, canReadPolicy, canBrowseOidcRecipients, oidcRecipientSearch, reload]);

  useEffect(() => {
    let active = true;
    const generation = ++apiKeyCatalogGeneration.current;
    if (!canReadPolicy) return () => { active = false; };
    setApiKeyCatalog({ kind: 'loading' });
    const timer = setTimeout(() => {
      void client.getCostPolicyScopeCatalog(tenantId, { kind: 'api-keys', q: apiKeySearch, limit: 50 }).then((result) => {
        if (!active || generation !== apiKeyCatalogGeneration.current) return;
        if (result.ok && result.data.kind === 'api-keys') setApiKeyCatalog({ kind: 'ready', data: result.data });
        else setApiKeyCatalog({ kind: 'failed', problem: result.ok
          ? { status: 502, code: 'INVALID_RESPONSE', title: 'API key catalog response did not match the request.' }
          : result.problem });
      }).catch((error: unknown) => {
        if (active) setApiKeyCatalog({ kind: 'failed', problem: isAdminApiProblem(error) ? error : { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'API key catalog could not be reached.' } });
      });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [client, tenantId, canReadPolicy, apiKeySearch, reload]);

  useEffect(() => {
    let active = true;
    const generation = ++profileCatalogGeneration.current;
    if (!canReadPolicy) return () => { active = false; };
    setProfileCatalog({ kind: 'loading' });
    const timer = setTimeout(() => {
      void client.getCostPolicyScopeCatalog(tenantId, {
        kind: 'profiles', q: profileSearch, limit: 50,
        ...(form.apiKeyId ? { apiKeyId: form.apiKeyId } : {}),
      }).then((result) => {
        if (!active || generation !== profileCatalogGeneration.current) return;
        if (result.ok && result.data.kind === 'profiles') setProfileCatalog({ kind: 'ready', data: result.data });
        else setProfileCatalog({ kind: 'failed', problem: result.ok
          ? { status: 502, code: 'INVALID_RESPONSE', title: 'Profile catalog response did not match the request.' }
          : result.problem });
      }).catch((error: unknown) => {
        if (active) setProfileCatalog({ kind: 'failed', problem: isAdminApiProblem(error) ? error : { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'Profile catalog could not be reached.' } });
      });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [client, tenantId, canReadPolicy, profileSearch, form.apiKeyId, reload]);

  useEffect(() => {
    let active = true;
    const generation = ++businessCatalogGeneration.current;
    if (!canReadPolicy) return () => { active = false; };
    setBusinessCatalog({ kind: 'loading' });
    const timer = setTimeout(() => {
      void client.getCostPolicyScopeCatalog(tenantId, {
        kind: 'businesses', q: businessSearch, limit: 50,
        ...(form.profileId && form.apiKeyId ? { profileId: form.profileId, apiKeyId: form.apiKeyId } : {}),
      }).then((result) => {
        if (!active || generation !== businessCatalogGeneration.current) return;
        if (result.ok && result.data.kind === 'businesses') setBusinessCatalog({ kind: 'ready', data: result.data });
        else setBusinessCatalog({ kind: 'failed', problem: result.ok
          ? { status: 502, code: 'INVALID_RESPONSE', title: 'Business catalog response did not match the request.' }
          : result.problem });
      }).catch((error: unknown) => {
        if (active) setBusinessCatalog({ kind: 'failed', problem: isAdminApiProblem(error) ? error : { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'Business catalog could not be reached.' } });
      });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [client, tenantId, canReadPolicy, businessSearch, form.profileId, form.apiKeyId, reload]);

  useEffect(() => {
    let active = true;
    if (!form.apiKeyId) { setSelectedApiKey(null); return () => { active = false; }; }
    void client.getCostPolicyScopeCatalog(tenantId, { kind: 'api-keys', q: form.apiKeyId, limit: 100 }).then((result) => {
      if (active && result.ok && result.data.kind === 'api-keys') setSelectedApiKey(result.data.items.find((item) => item.id === form.apiKeyId) ?? null);
    }).catch(() => { if (active) setSelectedApiKey(null); });
    return () => { active = false; };
  }, [client, tenantId, form.apiKeyId, reload]);

  useEffect(() => {
    let active = true;
    if (!form.profileId || !form.apiKeyId) { setSelectedProfile(null); return () => { active = false; }; }
    void client.getCostPolicyScopeCatalog(tenantId, { kind: 'profiles', q: form.profileId, apiKeyId: form.apiKeyId, limit: 100 }).then((result) => {
      if (active && result.ok && result.data.kind === 'profiles') setSelectedProfile(result.data.items.find((item) => item.id === form.profileId) ?? null);
    }).catch(() => { if (active) setSelectedProfile(null); });
    return () => { active = false; };
  }, [client, tenantId, form.apiKeyId, form.profileId, reload]);

  useEffect(() => {
    let active = true;
    if (!form.businessId) { setSelectedBusiness(null); return () => { active = false; }; }
    void client.getCostPolicyScopeCatalog(tenantId, {
      kind: 'businesses', q: form.businessId, limit: 100,
      ...(form.profileId && form.apiKeyId ? { profileId: form.profileId, apiKeyId: form.apiKeyId } : {}),
    }).then((result) => {
      if (active && result.ok && result.data.kind === 'businesses') setSelectedBusiness(result.data.items.find((item) => item.id === form.businessId) ?? null);
    }).catch(() => { if (active) setSelectedBusiness(null); });
    return () => { active = false; };
  }, [client, tenantId, form.businessId, form.apiKeyId, form.profileId, reload]);

  useEffect(() => {
    let active = true;
    if (newBudget) {
      setDetail(null);
      setDetailProblem(null);
      setForm(emptyBudgetForm());
      setBinding({ kind: 'failed', problem: { status: 404, code: 'NOT_FOUND', title: 'Publish a budget revision before assigning an alert owner.' } });
      setOwnerSelection('');
      return () => { active = false; };
    }
    setDetail(null);
    setDetailProblem(null);
    setBinding({ kind: 'loading' });
    void client.getCostBudget(tenantId, selectedBudgetId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setDetailProblem(result.problem);
        setBinding({ kind: 'failed', problem: result.problem });
        return;
      }
      setDetail(result.data);
      const head = result.data.revisions.find((revision) => revision.revision === result.data.headRevision);
      if (head) setForm(budgetFormFrom(head.config));
      if (result.data.activeRevision !== null) {
        void client.getCostBudgetAlertBinding(tenantId, selectedBudgetId, result.data.activeRevision).then((bindingResult) => {
          if (!active) return;
          if (bindingResult.ok) {
            setBinding({ kind: 'ready', data: bindingResult.data });
            setOwnerSelection(ownerSelectionFromBinding(bindingResult.data?.owner));
          } else setBinding({ kind: 'failed', problem: bindingResult.problem });
        });
      } else {
        setBinding({ kind: 'failed', problem: { status: 404, code: 'NOT_FOUND', title: 'Publish a budget revision before assigning an alert owner.' } });
      }
    }).catch(() => {
      if (active) setDetailProblem({ status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'Budget revision history could not be reached.' });
    });
    return () => { active = false; };
  }, [client, tenantId, selectedBudgetId, newBudget, reload]);

  const chooseBudget = (value: string) => {
    setSelectedBudgetId(value);
    setBudgetMessage(null);
    setBudgetError(null);
  };

  const toggleChannel = (channelId: string) => {
    setForm((current) => ({
      ...current,
      channelIds: current.channelIds.includes(channelId)
        ? current.channelIds.filter((id) => id !== channelId)
        : [...current.channelIds, channelId],
    }));
  };

  const saveBudgetDraft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBudgetMessage(null);
    setBudgetError(budgetPreview.error);
    if (!budgetPreview.config) return;
    setBudgetBusy(true);
    const result = await client.createCostBudgetDraft({
      ...(newBudget ? {} : { budgetId: selectedBudgetId }),
      expectedHeadRevision: newBudget ? 0 : detail?.headRevision ?? -1,
      config: budgetPreview.config,
    }, freshIdempotencyKey('cost-budget-draft'));
    setBudgetBusy(false);
    if (!result.ok) { setBudgetError(problemText(result.problem)); return; }
    setBudgetMessage(`Draft revision ${result.data.revision} saved. Review and publish it to affect new invocations.`);
    setSelectedBudgetId(result.data.budgetId);
    setReload((value) => value + 1);
  };

  const transitionBudget = async (action: 'review' | 'publish' | 'retire') => {
    if (!latestBudget || !detail) return;
    if ((action === 'review' || action === 'retire') && policyReason.trim().length < 8) {
      setBudgetError('Enter a review reason with at least 8 characters.');
      return;
    }
    setBudgetBusy(true);
    setBudgetError(null);
    const result = await client.transitionCostBudget(selectedBudgetId, action, {
      expectedState: latestBudget.state,
      expectedHeadRevision: detail.headRevision,
      ...(policyReason.trim().length >= 8 ? { reviewerReason: policyReason.trim() } : {}),
    }, freshIdempotencyKey(`cost-budget-${action}`));
    setBudgetBusy(false);
    if (!result.ok) { setBudgetError(problemText(result.problem)); return; }
    setBudgetMessage(`Budget revision ${result.data.revision} is now ${result.data.state.toLowerCase()}.`);
    setReload((value) => value + 1);
  };

  const rollbackBudget = async () => {
    if (!detail || !rollbackSource) return;
    if (policyReason.trim().length < 8) { setBudgetError('Enter a review reason with at least 8 characters.'); return; }
    setBudgetBusy(true);
    setBudgetError(null);
    const result = await client.rollbackCostBudget(selectedBudgetId, {
      sourceRevision: Number(rollbackSource),
      expectedHeadRevision: detail.headRevision,
      reviewerReason: policyReason.trim(),
    }, freshIdempotencyKey('cost-budget-rollback'));
    setBudgetBusy(false);
    if (!result.ok) { setBudgetError(problemText(result.problem)); return; }
    setBudgetMessage(`Rollback draft ${result.data.revision} created from revision ${rollbackSource}.`);
    setReload((value) => value + 1);
  };

  const registerOwnOidcRecipient = async () => {
    setOidcRecipientRegistrationBusy(true);
    setOidcRecipientLifecycleError(null);
    setOidcRecipientLifecycleMessage(null);
    try {
      const result = await client.ensureCostAlertSelfRecipient();
      if (!result.ok) { setOidcRecipientLifecycleError(problemText(result.problem)); return; }
      setOwnerSelection(`oidc:${result.data.principalId}`);
      setOidcRecipientLifecycleMessage(`Current OIDC Admin is registered for the owner-scoped inbox as ${result.data.displayName}.`);
      setReload((value) => value + 1);
    } catch (error) {
      setOidcRecipientLifecycleError(isAdminApiProblem(error) ? problemText(error) : 'Current OIDC recipient registration could not be completed.');
    } finally {
      setOidcRecipientRegistrationBusy(false);
    }
  };

  const changeOidcRecipientLifecycle = async (recipient: CostAlertRecipient, action: 'disable' | 'enable' | 'revoke') => {
    if (oidcRecipientReason.trim().length < 8) {
      setOidcRecipientLifecycleError('Enter a reason with at least 8 characters before changing recipient state.');
      return;
    }
    setOidcRecipientLifecycleBusy(recipient.principalId);
    setOidcRecipientLifecycleError(null);
    setOidcRecipientLifecycleMessage(null);
    try {
      const result = await client.transitionCostAlertRecipient(recipient.principalId, {
        expectedAuthorizationVersion: recipient.authorizationVersion,
        action,
        reason: oidcRecipientReason.trim(),
      }, freshIdempotencyKey('cost-alert-recipient'));
      if (!result.ok) {
        setOidcRecipientLifecycleError(problemText(result.problem));
        setReload((value) => value + 1);
        return;
      }
      setOidcRecipients((current) => current.kind === 'ready' ? { kind: 'ready', data: current.data.map((item) => item.principalId === result.data.principalId
        ? { ...item, state: result.data.state, authorizationVersion: result.data.authorizationVersion, eligible: result.data.state === 'ENABLED' && item.role === 'ADMIN' }
        : item) } : current);
      setOidcRecipientLifecycleMessage(`Recipient state changed to ${result.data.state.toLowerCase()}. This affects alert inbox access only; ordinary OIDC Admin access is unchanged.`);
    } catch (error) {
      setOidcRecipientLifecycleError(isAdminApiProblem(error) ? problemText(error) : 'Recipient state could not be changed.');
    } finally {
      setOidcRecipientLifecycleBusy(null);
    }
  };

  const saveBinding = async () => {
    if (!detail || detail.activeRevision === null || !ownerSelection || channels.kind !== 'ready') return;
    const owner = ownerSelection.startsWith('oidc:')
      ? { kind: 'oidc' as const, principalId: ownerSelection.slice('oidc:'.length) }
      : ownerSelection.startsWith('local:')
        ? { kind: 'local' as const, userId: ownerSelection.slice('local:'.length) }
        : null;
    if (!owner) return;
    const channelRefs = channels.data.channels.filter((channel) => activeChannelIds.includes(channel.channelId));
    if (channelRefs.length !== activeChannelIds.length || channelRefs.length === 0) {
      setBindingError('Publish the selected in-app channel on this budget revision before assigning an owner.');
      return;
    }
    setBindingBusy(true);
    setBindingError(null);
    const existing = binding.kind === 'ready' ? binding.data : null;
    const result = await client.saveCostBudgetAlertBinding({
      tenantId,
      budgetId: selectedBudgetId,
      budgetRevision: detail.activeRevision,
      expectedBindingRevision: existing?.bindingRevision ?? 0,
      owner,
      channels: channelRefs.map(({ channelId, channelRevision }) => ({ channelId, channelRevision })),
    }, freshIdempotencyKey('cost-alert-owner'));
    setBindingBusy(false);
    if (!result.ok) { setBindingError(problemText(result.problem)); return; }
    setBinding({ kind: 'ready', data: result.data });
    setBindingMessage(`Owner and channel mapping saved for published revision ${detail.activeRevision}.`);
  };

  const loadMoreApiKeys = async () => {
    if (apiKeyCatalog.kind !== 'ready' || !apiKeyCatalog.data.nextCursor) return;
    const generation = apiKeyCatalogGeneration.current;
    setLoadingMoreScope((current) => ({ ...current, apiKeys: true }));
    try {
      const result = await client.getCostPolicyScopeCatalog(tenantId, {
        kind: 'api-keys', q: apiKeySearch, limit: 50, cursor: apiKeyCatalog.data.nextCursor,
      });
      if (generation !== apiKeyCatalogGeneration.current) return;
      if (result.ok && result.data.kind === 'api-keys') {
        const page = result.data as ApiKeyScopePage;
        setApiKeyCatalog((current) => current.kind === 'ready' ? { kind: 'ready', data: {
          ...page, items: uniqueScopeItems([...current.data.items, ...page.items], null, (item) => item.id),
        } } : current);
      } else if (!result.ok) setApiKeyCatalog({ kind: 'failed', problem: result.problem });
    } catch (error) {
      if (generation === apiKeyCatalogGeneration.current) setApiKeyCatalog({ kind: 'failed', problem: isAdminApiProblem(error) ? error : { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'API key catalog could not be reached.' } });
    } finally { setLoadingMoreScope((current) => ({ ...current, apiKeys: false })); }
  };

  const loadMoreProfiles = async () => {
    if (profileCatalog.kind !== 'ready' || !profileCatalog.data.nextCursor) return;
    const generation = profileCatalogGeneration.current;
    setLoadingMoreScope((current) => ({ ...current, profiles: true }));
    try {
      const result = await client.getCostPolicyScopeCatalog(tenantId, {
        kind: 'profiles', q: profileSearch, limit: 50, cursor: profileCatalog.data.nextCursor,
        ...(form.apiKeyId ? { apiKeyId: form.apiKeyId } : {}),
      });
      if (generation !== profileCatalogGeneration.current) return;
      if (result.ok && result.data.kind === 'profiles') {
        const page = result.data as ProfileScopePage;
        setProfileCatalog((current) => current.kind === 'ready' ? { kind: 'ready', data: {
          ...page, items: uniqueScopeItems([...current.data.items, ...page.items], null, (item) => `${item.apiKeyId}:${item.id}`),
        } } : current);
      } else if (!result.ok) setProfileCatalog({ kind: 'failed', problem: result.problem });
    } catch (error) {
      if (generation === profileCatalogGeneration.current) setProfileCatalog({ kind: 'failed', problem: isAdminApiProblem(error) ? error : { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'Profile catalog could not be reached.' } });
    } finally { setLoadingMoreScope((current) => ({ ...current, profiles: false })); }
  };

  const loadMoreBusinesses = async () => {
    if (businessCatalog.kind !== 'ready' || !businessCatalog.data.nextCursor) return;
    const generation = businessCatalogGeneration.current;
    setLoadingMoreScope((current) => ({ ...current, businesses: true }));
    try {
      const result = await client.getCostPolicyScopeCatalog(tenantId, {
        kind: 'businesses', q: businessSearch, limit: 50, cursor: businessCatalog.data.nextCursor,
        ...(form.profileId && form.apiKeyId ? { profileId: form.profileId, apiKeyId: form.apiKeyId } : {}),
      });
      if (generation !== businessCatalogGeneration.current) return;
      if (result.ok && result.data.kind === 'businesses') {
        const page = result.data as BusinessScopePage;
        setBusinessCatalog((current) => current.kind === 'ready' ? { kind: 'ready', data: {
          ...page, items: uniqueScopeItems([...current.data.items, ...page.items], null, (item) => item.id),
        } } : current);
      } else if (!result.ok) setBusinessCatalog({ kind: 'failed', problem: result.problem });
    } catch (error) {
      if (generation === businessCatalogGeneration.current) setBusinessCatalog({ kind: 'failed', problem: isAdminApiProblem(error) ? error : { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'Business catalog could not be reached.' } });
    } finally { setLoadingMoreScope((current) => ({ ...current, businesses: false })); }
  };

  const loadMoreOidcRecipients = async () => {
    if (oidcRecipients.kind !== 'ready' || !oidcRecipientCursor || !canBrowseOidcRecipients) return;
    const generation = recipientCatalogGeneration.current;
    setOidcRecipientLoadingMore(true);
    try {
      const result = await client.listCostAlertRecipients({ tenantId, q: oidcRecipientSearch, limit: 50, cursor: oidcRecipientCursor });
      if (generation !== recipientCatalogGeneration.current) return;
      if (!result.ok) { setOidcRecipients({ kind: 'failed', problem: result.problem }); return; }
      if (result.data.tenantId !== tenantId) {
        setOidcRecipients({ kind: 'failed', problem: { status: 502, code: 'INVALID_RESPONSE', title: 'Recipient catalog returned a different tenant.' } });
        return;
      }
      setOidcRecipients((current) => current.kind === 'ready' ? { kind: 'ready', data: [
        ...new Map([...current.data, ...result.data.items].map((recipient) => [recipient.principalId, recipient])).values(),
      ] } : current);
      setOidcRecipientCursor(result.data.nextCursor);
      setOidcRecipientHasMore(result.data.hasMore);
    } catch (error) {
      if (generation === recipientCatalogGeneration.current) setOidcRecipients({ kind: 'failed', problem: isAdminApiProblem(error) ? error : { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'OIDC recipient catalog could not be reached.' } });
    } finally {
      setOidcRecipientLoadingMore(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Budget policy</CardTitle>
          <CardDescription>Immutable tenant-scoped budget revisions. Draft changes have no effect until they pass review and publish.</CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {!canReadPolicy ? <p role="status" className="text-sm text-[var(--text-sub)]">Cost policy controls are hidden from local USER and viewer sessions. Usage and cost read access remains under its existing scope.</p> : null}
          {budgets.kind === 'loading' ? <p role="status" className="text-sm text-[var(--text-sub)]">Loading budget policies…</p> : null}
          {budgets.kind === 'failed' && canReadPolicy ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{problemText(budgets.problem)}</p> : null}
          {budgets.kind === 'ready' ? (
            <>
              <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(14rem,22rem)_1fr]">
                <FormField label="Budget policy">
                  <NativeSelect aria-label="Choose a budget policy" value={selectedBudgetId} onChange={(event) => chooseBudget(event.target.value)}>
                    <option value="new">Create a new budget</option>
                    {budgets.data.budgets.map((head) => <option key={head.budgetId} value={head.budgetId}>{head.latest?.config.businessId ?? 'Tenant'} · {head.latest?.config.period ?? 'empty'} · {head.latest?.state ?? 'no revision'}</option>)}
                  </NativeSelect>
                </FormField>
                <div className="flex items-end text-xs text-[var(--text-sub)]">Cost values are integer micro-USD; publishing a revision does not reset existing used or held quota.</div>
              </div>

              <form onSubmit={(event) => void saveBudgetDraft(event)} className="flex min-w-0 flex-col gap-4 border-t border-[var(--border-subtle)] pt-4">
                <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <FormField label="Window">
                    <NativeSelect value={form.period} onChange={(event) => setForm({ ...form, period: event.target.value as BudgetForm['period'] })}>
                      <option value="daily">Daily (UTC)</option><option value="monthly">Monthly (UTC)</option>
                    </NativeSelect>
                  </FormField>
                  <FormField label="Token limit">
                    <Input inputMode="numeric" value={form.tokenThreshold} onChange={(event) => setForm({ ...form, tokenThreshold: event.target.value })} />
                  </FormField>
                  <FormField label="Spend limit (USD)" description="Up to 6 decimal places; stored as integer micro-USD.">
                    <Input inputMode="decimal" value={form.usdThreshold} onChange={(event) => setForm((current) => ({ ...current, usdThreshold: event.target.value }))} />
                  </FormField>
                  <FormField label="Warning threshold (%)">
                    <Input inputMode="numeric" value={form.alertThresholdPercent} onChange={(event) => setForm({ ...form, alertThresholdPercent: event.target.value })} />
                  </FormField>
                  <FormField label="Enforcement policy">
                    <NativeSelect value={form.policy} onChange={(event) => setForm({ ...form, policy: event.target.value as BudgetForm['policy'] })}>
                      <option value="alert-only">Alert only</option><option value="block-new-invocations">Block new invocations</option>
                    </NativeSelect>
                  </FormField>
                  <FormField label="Budget status">
                    <NativeSelect value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as BudgetForm['status'] })}>
                      <option value="active">Active</option><option value="suspended">Suspended</option>
                    </NativeSelect>
                  </FormField>
                  <FormField label="API key scope" description="Any key applies the limit across all tenant keys.">
                    <Input aria-label="Search API keys" placeholder="Search by key prefix" value={apiKeySearch} onChange={(event) => setApiKeySearch(event.target.value)} />
                    <NativeSelect aria-label="Budget API key scope" value={form.apiKeyId} onChange={(event) => {
                      const apiKeyId = event.target.value;
                      setSelectedApiKey(scopeOptions.apiKeys.find((key) => key.id === apiKeyId) ?? null);
                      if (apiKeyId !== form.apiKeyId) {
                        setSelectedProfile(null);
                        setSelectedBusiness(null);
                      }
                      setForm((current) => {
                        return apiKeyId === current.apiKeyId ? { ...current, apiKeyId }
                          : { ...current, apiKeyId, profileId: '', businessId: '' };
                      });
                    }}>
                      <option value="">All tenant API keys</option>
                      {scopeOptions.apiKeys.map((key) => <option key={key.id} value={key.id}>{key.label}</option>)}
                    </NativeSelect>
                    {apiKeyCatalog.kind === 'loading' ? <span role="status" className="text-xs text-[var(--text-sub)]">Loading key options…</span> : null}
                    {apiKeyCatalog.kind === 'ready' && apiKeyCatalog.data.hasMore ? <button type="button" disabled={loadingMoreScope.apiKeys} onClick={() => void loadMoreApiKeys()} className="text-left text-xs text-[var(--text-link)] disabled:opacity-50">{loadingMoreScope.apiKeys ? 'Loading more keys…' : `Load more API keys (${apiKeyCatalog.data.items.length} shown)`}</button> : null}
                  </FormField>
                  <FormField label="Profile scope" description="Choices are current active profiles; choose a key first to narrow results.">
                    <Input aria-label="Search profiles" placeholder="Search profile, business, or action" value={profileSearch} onChange={(event) => setProfileSearch(event.target.value)} />
                    <NativeSelect aria-label="Budget profile scope" value={form.profileId} onChange={(event) => {
                      const chosen = scopeOptions.profiles.find((profile) => profile.id === event.target.value);
                      setSelectedProfile(chosen ?? null);
                      setSelectedBusiness(null);
                      setForm((current) => ({
                        ...current,
                        profileId: chosen?.id ?? '',
                        ...(chosen ? { apiKeyId: chosen.apiKeyId, businessId: chosen.businessId } : { businessId: '' }),
                      }));
                      if (chosen) setSelectedApiKey(scopeOptions.apiKeys.find((key) => key.id === chosen.apiKeyId) ?? null);
                    }}>
                      <option value="">All profiles</option>
                      {profileChoices(scopeOptions.profiles, form.apiKeyId).map((profile) => <option key={`${profile.apiKeyId}:${profile.id}`} value={profile.id}>{profile.label}</option>)}
                    </NativeSelect>
                    {profileCatalog.kind === 'loading' ? <span role="status" className="text-xs text-[var(--text-sub)]">Loading profile options…</span> : null}
                    {profileCatalog.kind === 'ready' && profileCatalog.data.hasMore ? <button type="button" disabled={loadingMoreScope.profiles} onClick={() => void loadMoreProfiles()} className="text-left text-xs text-[var(--text-link)] disabled:opacity-50">{loadingMoreScope.profiles ? 'Loading more profiles…' : `Load more profiles (${profileCatalog.data.items.length} shown)`}</button> : null}
                  </FormField>
                  <FormField label="Business scope" description="Only tenant profile or operation businesses appear; a selected profile narrows this list.">
                    <Input aria-label="Search businesses" placeholder="Search business" value={businessSearch} onChange={(event) => setBusinessSearch(event.target.value)} />
                    <NativeSelect aria-label="Budget business scope" value={form.businessId} onChange={(event) => {
                      const businessId = event.target.value;
                      setSelectedBusiness(scopeOptions.businesses.find((business) => business.id === businessId) ?? null);
                      setForm((current) => ({ ...current, businessId }));
                    }}>
                      <option value="">All tenant businesses</option>
                      {scopeOptions.businesses.map((business) => <option key={business.id} value={business.id}>{business.label}</option>)}
                    </NativeSelect>
                    {businessCatalog.kind === 'loading' ? <span role="status" className="text-xs text-[var(--text-sub)]">Loading business options…</span> : null}
                    {businessCatalog.kind === 'ready' && businessCatalog.data.hasMore ? <button type="button" disabled={loadingMoreScope.businesses} onClick={() => void loadMoreBusinesses()} className="text-left text-xs text-[var(--text-link)] disabled:opacity-50">{loadingMoreScope.businesses ? 'Loading more businesses…' : `Load more businesses (${businessCatalog.data.items.length} shown)`}</button> : null}
                  </FormField>
                </div>

                <fieldset className="flex min-w-0 flex-col gap-2 rounded border border-[var(--border-subtle)] p-3">
                  <legend className="px-1 text-xs font-semibold">Notification channel</legend>
                  <p className="text-xs text-[var(--text-sub)]">Choose the trusted in-app destination. A binding can only use channel IDs pinned to this exact published revision.</p>
                  {channels.kind === 'failed' ? <p role="alert" className="text-xs text-[var(--badge-danger-text)]">{problemText(channels.problem)}</p> : null}
                  {channels.kind === 'ready' && channels.data.channels.length === 0 ? <p className="text-xs text-[var(--text-sub)]">No enabled alert channels are configured.</p> : null}
                  {channels.kind === 'ready' ? channels.data.channels.map((channel) => (
                    <label key={`${channel.channelId}:${channel.channelRevision}`} className="flex items-start gap-2 text-sm">
                      <input type="checkbox" checked={form.channelIds.includes(channel.channelId)} onChange={() => toggleChannel(channel.channelId)} />
                      <span><span className="font-medium">{channel.displayName}</span><span className="ml-2 text-xs text-[var(--text-sub)]">revision {channel.channelRevision} · {channel.destinationLabel}</span></span>
                    </label>
                  )) : null}
                </fieldset>

                <div className="rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-3">
                  <h3 className="text-xs font-semibold">Draft diff from current head</h3>
                  <ul className="mt-2 grid gap-1 text-xs text-[var(--text-sub)] sm:grid-cols-2">
                    {draftDiff.map((change) => <li key={change}>{change}</li>)}
                  </ul>
                </div>

                {[apiKeyCatalog, profileCatalog, businessCatalog].map((catalog, index) => catalog.kind === 'failed'
                  ? <p key={index} role="alert" className="text-sm text-[var(--badge-danger-text)]">Guided scope catalog could not load: {problemText(catalog.problem)}</p>
                  : null)}
                <p className="rounded border border-[var(--badge-warning-border)] bg-[var(--badge-warning-bg)] p-3 text-xs text-[var(--badge-warning-text)]">
                  A configured block policy fails closed before provider send if the request, price basis, earlier usage, or unresolved reservations lack a verified upper bound. The UI does not claim remaining capacity from incomplete trust. Choose Alert only explicitly if best-effort admission is intended.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" disabled={budgetBusy || !canReadPolicy || !budgetPreview.config || apiKeyCatalog.kind !== 'ready' || profileCatalog.kind !== 'ready' || businessCatalog.kind !== 'ready' || channels.kind !== 'ready'}>{budgetBusy ? 'Saving…' : 'Save draft revision'}</Button>
                  <span className="text-xs text-[var(--text-sub)]">{newBudget ? 'New budget head at revision 0' : `Expected current head ${detail?.headRevision ?? '…'}`}</span>
                </div>
                {budgetPreview.error ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{budgetPreview.error}</p> : null}
                {budgetError ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{budgetError}</p> : null}
                {budgetMessage ? <p role="status" className="text-sm text-[var(--badge-success-text)]">{budgetMessage}</p> : null}
              </form>

              {!newBudget && detailProblem ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{problemText(detailProblem)}</p> : null}
              {!newBudget && detail ? (
                <>
                  <div className="border-t border-[var(--border-subtle)] pt-4">
                    <h3 className="text-sm font-semibold">Revision history and review</h3>
                    <p className="mt-1 text-xs text-[var(--text-sub)]">{latestBudget ? `Head revision ${detail.headRevision} is ${latestBudget.state.toLowerCase()}. Active revision ${detail.activeRevision ?? 'none'} continues to govern new invocation admission.` : 'No revision is available.'}</p>
                    <div className="mt-3 flex min-w-0 flex-col gap-3">
                      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(16rem,1fr)_minmax(10rem,14rem)]">
                        <FormField label="Review / rollback reason">
                          <Input maxLength={512} value={policyReason} onChange={(event) => setPolicyReason(event.target.value)} placeholder="Explain this policy change" />
                        </FormField>
                        <FormField label="Rollback source revision">
                          <NativeSelect value={rollbackSource} onChange={(event) => setRollbackSource(event.target.value)}>
                            <option value="">Choose a revision</option>
                            {detail.revisions.filter((revision) => revision.revision < detail.headRevision).map((revision) => <option key={revision.revision} value={revision.revision}>Revision {revision.revision} · {revision.state}</option>)}
                          </NativeSelect>
                        </FormField>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {latestBudget?.state === 'DRAFT' ? <Button type="button" size="sm" variant="outline" disabled={budgetBusy} onClick={() => void transitionBudget('review')}>Submit for review</Button> : null}
                        {latestBudget?.state === 'REVIEW' ? <Button type="button" size="sm" disabled={budgetBusy} onClick={() => void transitionBudget('publish')}>Publish reviewed revision</Button> : null}
                        {latestBudget?.state === 'PUBLISHED' ? <Button type="button" size="sm" variant="outline" disabled={budgetBusy} onClick={() => void transitionBudget('retire')}>Retire revision</Button> : null}
                        <Button type="button" size="sm" variant="outline" disabled={budgetBusy || !rollbackSource} onClick={() => void rollbackBudget()}>Create rollback draft</Button>
                      </div>
                      <div className="max-h-[min(65dvh,32rem)] overflow-auto rounded border border-[var(--border-subtle)]" role="region" aria-label="Budget revision history" tabIndex={0}>
                        <table className="w-full min-w-[540px] text-left text-xs">
                          <thead className="sticky top-0 z-10 bg-[var(--bg-card)]"><tr className="border-b border-[var(--border-subtle)] text-[var(--text-sub)]"><th className="p-2">Revision</th><th className="p-2">State</th><th className="p-2">Created</th><th className="p-2">Published</th><th className="p-2">Digest</th></tr></thead>
                          <tbody>{[...detail.revisions].sort((left, right) => right.revision - left.revision).map((revision) => <tr key={revision.revision} className="border-b border-[var(--border-subtle)] last:border-0"><td className="p-2">{revision.revision}</td><td className="p-2"><Badge variant={revision.state === 'PUBLISHED' ? 'success' : revision.state === 'REVIEW' ? 'warning' : 'neutral'}>{revision.state}</Badge></td><td className="p-2">{new Date(revision.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</td><td className="p-2">{revision.publishedAt ? `${new Date(revision.publishedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—'}</td><td className="p-2 font-mono">{revision.contentDigest.slice(0, 18)}…</td></tr>)}</tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-[var(--border-subtle)] pt-4">
                    <h3 className="text-sm font-semibold">Published revision alert owner</h3>
                    <p className="mt-1 text-xs text-[var(--text-sub)]">Choose a current local tenant Admin or an enabled external OIDC platform Admin. The recipient kind and channel revision are pinned to this exact published budget revision.</p>
                    {detail.activeRevision === null ? <p className="mt-2 text-sm text-[var(--text-sub)]">Publish a budget revision before assigning its alert owner.</p> : (
                      <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-[minmax(16rem,24rem)_auto] sm:items-end">
                        <FormField label={`Owner for active budget revision ${detail.activeRevision}`}>
                          <NativeSelect value={ownerSelection} onChange={(event) => setOwnerSelection(event.target.value as OwnerSelection)}>
                            <option value="">Choose current tenant Admin</option>
                            {admins.kind === 'ready' ? admins.data.map((admin) => <option key={admin.id} value={`local:${admin.id}`}>Local · {admin.username}</option>) : null}
                            {localBindingOwnerMissing && currentBindingOwner && !('kind' in currentBindingOwner)
                              ? <option value={`local:${currentBindingOwner.userId}`} disabled>Local · {currentBindingOwner.displayName} (unavailable)</option>
                              : null}
                            {oidcRecipients.kind === 'ready' ? oidcRecipients.data.filter((recipient) => recipient.eligible).map((recipient) => <option key={recipient.principalId} value={`oidc:${recipient.principalId}`}>External OIDC · {recipient.displayName}</option>) : null}
                            {oidcBindingOwnerMissing && currentBindingOwner && 'kind' in currentBindingOwner
                              ? <option value={`oidc:${currentBindingOwner.principalId}`} disabled>External OIDC · {currentBindingOwner.displayName} (unavailable)</option>
                              : null}
                          </NativeSelect>
                        </FormField>
                        <Button type="button" disabled={bindingBusy || !selectedOwnerIsAvailable || channels.kind !== 'ready'} onClick={() => void saveBinding()}>{bindingBusy ? 'Saving…' : 'Save owner mapping'}</Button>
                        {canBrowseOidcRecipients ? (
                          <div className="grid gap-2 sm:col-span-2">
                            <div className="flex flex-wrap items-end gap-2">
                              <FormField label="Search external OIDC Admin recipients" className="min-w-[16rem] flex-1">
                                <Input aria-label="Search external OIDC recipients" value={oidcRecipientSearch} onChange={(event) => setOidcRecipientSearch(event.target.value)} placeholder="Search recipient display code" />
                              </FormField>
                              {oidcRecipientHasMore ? <Button type="button" size="sm" variant="outline" disabled={oidcRecipientLoadingMore} onClick={() => void loadMoreOidcRecipients()}>{oidcRecipientLoadingMore ? 'Loading…' : 'Load more recipients'}</Button> : null}
                            </div>
                            {oidcRecipients.kind === 'loading' ? <p role="status" className="text-xs text-[var(--text-sub)]">Loading external recipient directory…</p> : null}
                            {oidcRecipients.kind === 'failed' ? <p role="alert" className="text-xs text-[var(--badge-warning-text)]">External recipient directory: {problemText(oidcRecipients.problem)}. Register the current OIDC Admin in the notification inbox before selecting an external recipient.</p> : null}
                            <div className="flex flex-wrap items-center gap-2 rounded border border-[var(--border-subtle)] p-2">
                              <p className="flex-1 text-xs text-[var(--text-sub)]">Register this verified OIDC Admin as an owner-scoped inbox recipient. The server pins the opaque recipient ID to this current session.</p>
                              <Button type="button" size="sm" variant="outline" disabled={oidcRecipientRegistrationBusy} onClick={() => void registerOwnOidcRecipient()}>{oidcRecipientRegistrationBusy ? 'Registering…' : 'Register current OIDC Admin'}</Button>
                            </div>
                            {oidcRecipientLifecycleError ? <p role="alert" className="text-xs text-[var(--badge-danger-text)]">{oidcRecipientLifecycleError}</p> : null}
                            {oidcRecipientLifecycleMessage ? <p role="status" className="text-xs text-[var(--badge-success-text)]">{oidcRecipientLifecycleMessage}</p> : null}
                            {oidcRecipients.kind === 'ready' && oidcRecipients.data.length > 0 ? (
                              <fieldset className="grid gap-2 rounded border border-[var(--border-subtle)] p-3">
                                <legend className="px-1 text-xs font-semibold">External recipient state</legend>
                                <p className="text-xs text-[var(--text-sub)]">Disable, re-enable or revoke the alert recipient with a version check and audited reason. These changes affect alert inbox access only. Revocation is terminal.</p>
                                <FormField label="Recipient change reason">
                                  <Input maxLength={240} value={oidcRecipientReason} onChange={(event) => setOidcRecipientReason(event.target.value)} placeholder="Explain this notification directory change" />
                                </FormField>
                                <div className="grid gap-2">
                                  {oidcRecipients.data.map((recipient) => (
                                    <div key={recipient.principalId} className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-2 first:border-0 first:pt-0">
                                      <span className="min-w-48 flex-1 text-xs">{recipient.displayName} · {recipient.state.toLowerCase()} · version {recipient.authorizationVersion} · last verified {new Date(recipient.lastVerifiedAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}</span>
                                      {recipient.state === 'ENABLED' ? <Button type="button" size="sm" variant="outline" disabled={oidcRecipientLifecycleBusy !== null || oidcRecipientReason.trim().length < 8} onClick={() => void changeOidcRecipientLifecycle(recipient, 'disable')}>Disable</Button> : null}
                                      {recipient.state === 'DISABLED' ? <Button type="button" size="sm" variant="outline" disabled={oidcRecipientLifecycleBusy !== null || oidcRecipientReason.trim().length < 8} onClick={() => void changeOidcRecipientLifecycle(recipient, 'enable')}>Re-enable</Button> : null}
                                      {recipient.state !== 'REVOKED' ? <Button type="button" size="sm" variant="outline" disabled={oidcRecipientLifecycleBusy !== null || oidcRecipientReason.trim().length < 8} onClick={() => void changeOidcRecipientLifecycle(recipient, 'revoke')}>Revoke</Button> : null}
                                    </div>
                                  ))}
                                </div>
                              </fieldset>
                            ) : null}
                          </div>
                        ) : null}
                        <p className="text-xs text-[var(--text-sub)] sm:col-span-2">Pinned channels: {activeChannelIds.length ? activeChannelIds.map((channelId) => channels.kind === 'ready' ? channels.data.channels.find((channel) => channel.channelId === channelId)?.displayName ?? `${channelId} (unavailable)` : channelId).join(', ') : 'None. Add an in-app channel to a new draft and publish it first.'}</p>
                        {binding.kind === 'ready' && binding.data ? <p className="text-xs text-[var(--text-sub)] sm:col-span-2">Current mapping revision {binding.data.bindingRevision}: {binding.data.owner.displayName} → {binding.data.channels.map((channel) => `${channel.channelId}@${channel.channelRevision}`).join(', ')}.</p> : null}
                        {binding.kind === 'failed' && binding.problem.status !== 404 ? <p className="text-xs text-[var(--text-sub)] sm:col-span-2">{problemText(binding.problem)}</p> : null}
                        {admins.kind === 'failed' ? <p role="alert" className="text-xs text-[var(--badge-danger-text)] sm:col-span-2">Identity owner catalog: {problemText(admins.problem)}</p> : null}
                        {bindingError ? <p role="alert" className="text-xs text-[var(--badge-danger-text)] sm:col-span-2">{bindingError}</p> : null}
                        {bindingMessage ? <p role="status" className="text-xs text-[var(--badge-success-text)] sm:col-span-2">{bindingMessage}</p> : null}
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      {canManagePrices ? <PriceBookEditor client={client} state={prices} onReload={() => setReload((value) => value + 1)} /> : null}
    </div>
  );
}

function profileChoices(profiles: CostPolicyScopeProfile[], apiKeyId: string): Array<{ id: string; apiKeyId: string; label: string }> {
  const choices = new Map<string, { id: string; apiKeyId: string; label: string }>();
  for (const profile of profiles) {
    if (apiKeyId && profile.apiKeyId !== apiKeyId) continue;
    const key = `${profile.apiKeyId}:${profile.id}`;
    if (!choices.has(key)) choices.set(key, {
      id: profile.id,
      apiKeyId: profile.apiKeyId,
      label: `${profile.profileName} · ${profile.businessId} ${profile.businessVersion} / ${profile.action} · ${profile.apiKeyLabel}`,
    });
  }
  return [...choices.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function uniqueScopeItems<T>(items: T[], selected: T | null, keyOf: (item: T) => string): T[] {
  const unique = new Map<string, T>();
  if (selected) unique.set(keyOf(selected), selected);
  for (const item of items) unique.set(keyOf(item), item);
  return [...unique.values()];
}

function isAdminApiProblem(value: unknown): value is AdminApiProblem {
  return typeof value === 'object' && value !== null && 'status' in value && 'code' in value;
}

function PriceBookEditor({ client, state, onReload }: { client: AdminApiClient; state: DataState<CostControlPriceList> | null; onReload: () => void }) {
  const [tiers, setTiers] = useState<PriceTierForm[]>([defaultPriceTier()]);
  const [sourceRevision, setSourceRevision] = useState('');
  const [rollbackSource, setRollbackSource] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest: PersistedPriceRevision | null = state?.kind === 'ready'
    ? state.data.revisions.find((revision) => revision.revision === state.data.headRevision) ?? null : null;
  const active: PersistedPriceRevision | null = state?.kind === 'ready' && state.data.activeRevision !== null
    ? state.data.revisions.find((revision) => revision.revision === state.data.activeRevision) ?? null : null;
  const tierPreview = priceTableFromForms(tiers);
  const baseline = state?.kind === 'ready'
    ? state.data.revisions.find((revision) => revision.revision === Number(sourceRevision))?.tiers ?? latest?.tiers ?? []
    : [];

  useEffect(() => {
    if (state?.kind !== 'ready') return;
    const head = state.data.revisions.find((revision) => revision.revision === state.data.headRevision);
    if (!head) { setTiers([defaultPriceTier()]); setSourceRevision(''); return; }
    setTiers(head.tiers.length ? head.tiers.map(toPriceTierForm) : [defaultPriceTier()]);
    setSourceRevision(String(head.revision));
  }, [state]);

  const patchTier = (index: number, patch: Partial<PriceTierForm>) => setTiers((current) => current.map((tier, row) => row === index ? { ...tier, ...patch } : tier));
  const createDraft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(tierPreview.error);
    setMessage(null);
    if (!tierPreview.tiers || state?.kind !== 'ready') return;
    setBusy(true);
    const result = await client.createCostPriceDraft({ expectedHeadRevision: state.data.headRevision, tiers: tierPreview.tiers }, freshIdempotencyKey('cost-price-draft'));
    setBusy(false);
    if (!result.ok) { setError(problemText(result.problem)); return; }
    setMessage(`Price draft revision ${result.data.revision} saved. Review and publish it before new usage can select it.`);
    onReload();
  };
  const transition = async (action: 'review' | 'publish' | 'retire') => {
    if (!latest || state?.kind !== 'ready') return;
    if ((action === 'review' || action === 'retire') && reason.trim().length < 8) { setError('Enter a review reason with at least 8 characters.'); return; }
    setBusy(true);
    setError(null);
    const result = await client.transitionCostPrice(action, {
      expectedState: latest.state,
      expectedHeadRevision: state.data.headRevision,
      ...(reason.trim().length >= 8 ? { reviewerReason: reason.trim() } : {}),
    }, freshIdempotencyKey(`cost-price-${action}`));
    setBusy(false);
    if (!result.ok) { setError(problemText(result.problem)); return; }
    setMessage(`Price revision ${result.data.revision} is now ${result.data.state.toLowerCase()}.`);
    onReload();
  };
  const rollback = async () => {
    if (!state || state.kind !== 'ready' || !rollbackSource || reason.trim().length < 8) { setError('Choose a source revision and enter a reason with at least 8 characters.'); return; }
    setBusy(true);
    setError(null);
    const result = await client.rollbackCostPrice({ sourceRevision: Number(rollbackSource), expectedHeadRevision: state.data.headRevision, reviewerReason: reason.trim() }, freshIdempotencyKey('cost-price-rollback'));
    setBusy(false);
    if (!result.ok) { setError(problemText(result.problem)); return; }
    setMessage(`Price rollback draft ${result.data.revision} created from revision ${rollbackSource}.`);
    onReload();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Published price book</CardTitle>
        <CardDescription>Platform Admin price revisions use structured tier rows, whole micro-USD rates, review, publish, history, retirement, and CAS rollback.</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {state?.kind === 'loading' || state === null ? <p role="status" className="text-sm text-[var(--text-sub)]">Loading price book…</p> : null}
        {state?.kind === 'failed' ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{problemText(state.problem)}</p> : null}
        {state?.kind === 'ready' ? (
          <>
            <p className="text-xs text-[var(--text-sub)]">Head {state.data.headRevision} · active {state.data.activeRevision ?? 'none'}{active ? ` · active revision ${active.revision}` : ''}</p>
            <form onSubmit={(event) => void createDraft(event)} className="flex min-w-0 flex-col gap-4">
              <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
                <div className="min-w-[min(100%,18rem)] flex-1">
                  <FormField label="Draft source revision">
                    <NativeSelect value={sourceRevision} onChange={(event) => {
                      setSourceRevision(event.target.value);
                      const source = state.data.revisions.find((revision) => revision.revision === Number(event.target.value));
                      if (source) setTiers(source.tiers.length ? source.tiers.map(toPriceTierForm) : [defaultPriceTier()]);
                    }}>
                      {state.data.revisions.map((revision) => <option key={revision.revision} value={revision.revision}>Revision {revision.revision} · {revision.state}</option>)}
                    </NativeSelect>
                  </FormField>
                </div>
                <p className="text-xs text-[var(--text-sub)]">Diff: {tierPreview.tiers ? diffPriceTiers(baseline, tierPreview.tiers) : tierPreview.error}</p>
              </div>
              {tiers.map((tier, index) => (
                <fieldset key={index} className="grid min-w-0 gap-3 rounded border border-[var(--border-subtle)] p-3 sm:grid-cols-2 xl:grid-cols-4">
                  <legend className="px-1 text-xs font-semibold">Price tier {index + 1}</legend>
                  <FormField label="Provider (optional)"><Input maxLength={128} value={tier.provider} onChange={(event) => patchTier(index, { provider: event.target.value })} placeholder="Provider slug" /></FormField>
                  <FormField label="Model"><Input required maxLength={128} value={tier.modelId} onChange={(event) => patchTier(index, { modelId: event.target.value })} placeholder="Model ID" /></FormField>
                  <FormField label="Price version"><Input required inputMode="numeric" value={tier.priceVersion} onChange={(event) => patchTier(index, { priceVersion: event.target.value })} /></FormField>
                  <FormField label="Effective from (UTC)"><Input required type="datetime-local" value={tier.effectiveFrom} onChange={(event) => patchTier(index, { effectiveFrom: event.target.value })} /></FormField>
                  <FormField label="Effective to (UTC, optional)"><Input type="datetime-local" value={tier.effectiveTo} onChange={(event) => patchTier(index, { effectiveTo: event.target.value })} /></FormField>
                  <FormField label="Input USD / million tokens"><Input required inputMode="decimal" value={tier.inputUsdPerMillion} onChange={(event) => patchTier(index, { inputUsdPerMillion: event.target.value })} /></FormField>
                  <FormField label="Output USD / million tokens"><Input required inputMode="decimal" value={tier.outputUsdPerMillion} onChange={(event) => patchTier(index, { outputUsdPerMillion: event.target.value })} /></FormField>
                  <FormField label="Cached input USD / million (optional)"><Input inputMode="decimal" value={tier.cachedInputUsdPerMillion} onChange={(event) => patchTier(index, { cachedInputUsdPerMillion: event.target.value })} /></FormField>
                  <FormField label="Page USD / page (optional)"><Input inputMode="decimal" value={tier.pageUsdPerPage} onChange={(event) => patchTier(index, { pageUsdPerPage: event.target.value })} /></FormField>
                  <div className="flex items-end"><Button type="button" size="sm" variant="ghost" disabled={tiers.length <= 1} onClick={() => setTiers((current) => current.filter((_, row) => row !== index))}>Remove tier</Button></div>
                </fieldset>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => setTiers((current) => [...current, defaultPriceTier()])}>Add price tier</Button>
                <Button type="submit" disabled={busy || !tierPreview.tiers}>{busy ? 'Saving…' : 'Save price draft'}</Button>
              </div>
              <p className="text-xs text-[var(--text-sub)]">Enter USD rates to 6 decimal places; storage uses exact integer micro-USD. Overlapping provider/model effective windows or duplicate price versions are rejected before submission.</p>
            </form>
            <div className="border-t border-[var(--border-subtle)] pt-4">
              <h3 className="text-sm font-semibold">Price revision actions</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(16rem,1fr)_minmax(10rem,14rem)]">
                <FormField label="Review / rollback reason"><Input maxLength={512} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain the pricing change" /></FormField>
                <FormField label="Rollback source revision"><NativeSelect value={rollbackSource} onChange={(event) => setRollbackSource(event.target.value)}><option value="">Choose a revision</option>{state.data.revisions.filter((revision) => revision.revision < state.data.headRevision).map((revision) => <option key={revision.revision} value={revision.revision}>Revision {revision.revision} · {revision.state}</option>)}</NativeSelect></FormField>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {latest?.state === 'DRAFT' ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void transition('review')}>Submit for review</Button> : null}
                {latest?.state === 'REVIEW' ? <Button type="button" size="sm" disabled={busy} onClick={() => void transition('publish')}>Publish price book</Button> : null}
                {latest?.state === 'PUBLISHED' ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void transition('retire')}>Retire price revision</Button> : null}
                <Button type="button" size="sm" variant="outline" disabled={busy || !rollbackSource} onClick={() => void rollback()}>Create rollback draft</Button>
              </div>
            </div>
            {error ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{error}</p> : null}
            {message ? <p role="status" className="text-sm text-[var(--badge-success-text)]">{message}</p> : null}
            <div className="max-h-[min(65dvh,32rem)] overflow-auto rounded border border-[var(--border-subtle)]" role="region" aria-label="Price revision history" tabIndex={0}>
              <table className="w-full min-w-[500px] text-left text-xs">
                <thead className="sticky top-0 z-10 bg-[var(--bg-card)]"><tr className="border-b border-[var(--border-subtle)] text-[var(--text-sub)]"><th className="p-2">Revision</th><th className="p-2">State</th><th className="p-2">Tiers</th><th className="p-2">Created</th><th className="p-2">Digest</th></tr></thead>
                <tbody>{[...state.data.revisions].sort((left, right) => right.revision - left.revision).map((revision) => <tr key={revision.revision} className="border-b border-[var(--border-subtle)] last:border-0"><td className="p-2">{revision.revision}</td><td className="p-2"><Badge variant={revision.state === 'PUBLISHED' ? 'success' : revision.state === 'REVIEW' ? 'warning' : 'neutral'}>{revision.state}</Badge></td><td className="p-2">{revision.tiers.length}</td><td className="p-2">{new Date(revision.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</td><td className="p-2 font-mono">{revision.contentDigest.slice(0, 18)}…</td></tr>)}</tbody>
              </table>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
