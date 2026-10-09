import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertBanner,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FormField,
  Input,
  Modal,
  NativeSelect,
  StatePanel,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { useTenant } from '@/lib/tenant-context';
import {
  SECRET_PURPOSES,
  SECRET_SERVICES,
  createAdminApiClient,
  type AdminApiProblem,
  type SecretCatalogEntryRead,
  type SecretProbeResult,
  type SecretPurpose,
  type SecretService,
} from '@/lib/api';
import { parseSecretListPage, providerDetail, providerLabel, secretStateVariant } from './state';

/**
 * SC-03 — Secret catalog screen (`admin/secrets`).
 *
 * Lists tenant-scoped catalog metadata, creates managed values (write-only
 * password input) or Vault KV links, rotates and disables with CAS, and runs a
 * safe availability probe. Values are NEVER read back: reads carry metadata
 * only, the create/rotate literal is cleared immediately after submit, and the
 * probe returns availability/error codes only.
 */

type ProviderKind = 'managed_value' | 'vault_reference';

interface CreateDraft {
  name: string;
  purpose: SecretPurpose;
  services: SecretService[];
  providerKind: ProviderKind;
  value: string;
  connectionId: string;
  mount: string;
  path: string;
  field: string;
  namespace: string;
  versionMode: 'pinned' | 'latest';
  version: string;
}

function emptyCreateDraft(): CreateDraft {
  return {
    name: '',
    purpose: 'generic',
    services: ['orchestrator'],
    providerKind: 'managed_value',
    value: '',
    connectionId: '',
    mount: 'secret',
    path: '',
    field: '',
    namespace: '',
    versionMode: 'pinned',
    version: '1',
  };
}

/**
 * SC-03 / F6: a pinned Vault version must be a positive whole number.
 *
 * `Number('')`, `Number('abc')` and `Number('1.5')` all return NaN, and
 * `JSON.stringify` turns NaN into `null` — so an empty or non-numeric field
 * used to reach `client.createSecret` as `{ mode: 'pinned', version: null }`.
 * Validate here rather than trusting the input widget (`type="number"` only
 * constrains what the user can type, not what `value` ends up being).
 */
function parsePinnedVersion(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const version = Number(trimmed);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return version;
}

function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export function SecretsScreen(): React.JSX.Element {
  const { tenantId: globalTenantId, tenant } = useTenant();
  const tenantScope = globalTenantId ?? '';
  const client = useMemo(() => createAdminApiClient(), []);
  const [entries, setEntries] = useState<SecretCatalogEntryRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<AdminApiProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(emptyCreateDraft);
  const [createError, setCreateError] = useState<AdminApiProblem | null>(null);
  const [busy, setBusy] = useState(false);

  const [rotateTarget, setRotateTarget] = useState<SecretCatalogEntryRead | null>(null);
  const [rotateValue, setRotateValue] = useState('');
  const [rotateError, setRotateError] = useState<AdminApiProblem | null>(null);

  const [disableTarget, setDisableTarget] = useState<SecretCatalogEntryRead | null>(null);
  const [disableReason, setDisableReason] = useState('');
  const [disableError, setDisableError] = useState<AdminApiProblem | null>(null);

  const [testResults, setTestResults] = useState<Record<string, SecretProbeResult | 'pending'>>({});

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setProblem(null);
    const query: Record<string, string> = { limit: '100' };
    if (tenantScope.trim().length > 0) query.tenantId = tenantScope.trim();
    const result = await client.listSecrets(query);
    if (!result.ok) {
      setEntries([]);
      setProblem(result.problem);
      setLoading(false);
      return;
    }
    const page = parseSecretListPage(result.data);
    if (page === null) {
      setEntries([]);
      setProblem({ status: 502, code: 'UNREADABLE_RESPONSE', title: 'The secret list response did not match the catalog contract.' });
      setLoading(false);
      return;
    }
    setEntries(page.items);
    setLoading(false);
  }, [client, tenantScope]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateCreate(mutate: (current: CreateDraft) => CreateDraft): void {
    setCreateDraft((current) => mutate(current));
  }

  // SC-03 / F6: while a pinned version is invalid, Save stays disabled and the
  // field reports the reason, so the bad value cannot be submitted at all.
  const pinnedVersionInvalid = createDraft.providerKind === 'vault_reference'
    && createDraft.versionMode === 'pinned'
    && parsePinnedVersion(createDraft.version) === null;

  async function submitCreate(): Promise<void> {
    setBusy(true);
    setCreateError(null);
    const draft = createDraft;
    // SC-03 / F6: refuse the submit BEFORE any payload is built, so an invalid
    // pinned version can never become NaN -> null on the wire.
    if (draft.providerKind === 'vault_reference' && draft.versionMode === 'pinned'
      && parsePinnedVersion(draft.version) === null) {
      setCreateError({
        status: 422,
        code: 'INVALID_VERSION',
        title: 'Pinned version must be a whole number of 1 or more.',
        errors: [{
          pointer: '/provider/version',
          message: `expected a positive integer, got ${draft.version.trim() === '' ? 'an empty value' : JSON.stringify(draft.version)}`,
        }],
      });
      setBusy(false);
      return;
    }
    const provider = draft.providerKind === 'managed_value'
      ? { kind: 'managed_value' as const }
      : {
          kind: 'vault_reference' as const,
          connectionId: draft.connectionId.trim(),
          mount: draft.mount.trim(),
          path: draft.path.trim(),
          field: draft.field.trim(),
          ...(draft.namespace.trim().length > 0 ? { namespace: draft.namespace.trim() } : {}),
          version: draft.versionMode === 'pinned'
            // Guard above already rejected anything that does not parse to a
            // positive integer, so the assertion is provably non-null here.
            ? { mode: 'pinned' as const, version: parsePinnedVersion(draft.version)! }
            : { mode: 'latest' as const },
        };
    const result = await client.createSecret({
      tenantId: tenantScope.trim(),
      name: draft.name.trim(),
      purpose: draft.purpose,
      services: draft.services,
      provider,
      ...(draft.providerKind === 'managed_value' ? { value: { kind: 'literal' as const, value: draft.value } } : {}),
    }, newIdempotencyKey());
    setBusy(false);
    if (!result.ok) {
      setCreateError(result.problem);
      return;
    }
    setCreateDraft(emptyCreateDraft());
    setCreateOpen(false);
    setNotice(`Secret '${result.data.name}' saved. The value is write-only and can no longer be displayed.`);
    await load();
  }

  async function submitRotate(): Promise<void> {
    if (rotateTarget === null) return;
    setBusy(true);
    setRotateError(null);
    const result = await client.rotateSecret(rotateTarget.secretId, {
      expectedRevision: rotateTarget.revision,
      value: { kind: 'literal', value: rotateValue },
    }, newIdempotencyKey());
    setBusy(false);
    if (!result.ok) {
      setRotateError(result.problem);
      return;
    }
    setRotateValue('');
    setRotateTarget(null);
    setNotice(`Secret '${result.data.name}' rotated to revision ${result.data.revision}.`);
    await load();
  }

  async function submitDisable(): Promise<void> {
    if (disableTarget === null) return;
    setBusy(true);
    setDisableError(null);
    const result = await client.disableSecret(disableTarget.secretId, {
      expectedRevision: disableTarget.revision,
      reason: disableReason.trim(),
    }, newIdempotencyKey());
    setBusy(false);
    if (!result.ok) {
      setDisableError(result.problem);
      return;
    }
    setDisableReason('');
    setDisableTarget(null);
    setNotice(`Secret '${result.data.name}' disabled. Future resolutions fail closed.`);
    await load();
  }

  async function runTest(entry: SecretCatalogEntryRead): Promise<void> {
    setTestResults((current) => ({ ...current, [entry.secretId]: 'pending' }));
    const result = await client.testSecret(entry.secretId);
    setTestResults((current) => ({
      ...current,
      [entry.secretId]: result.ok
        ? result.data
        : { ok: false, errorCode: result.problem.code },
    }));
  }

  const state: 'loading' | 'empty' | 'error' | 'ready' = loading && entries.length === 0
    ? 'loading'
    : problem !== null && entries.length === 0
      ? 'error'
      : entries.length === 0
        ? 'empty'
        : 'ready';

  return (
    <section aria-labelledby="secrets-title" className="flex flex-col gap-5 min-w-0">
      <header className="flex flex-col gap-2">
        <h1 id="secrets-title" className="text-xl font-semibold text-[var(--text-main)]">Secrets</h1>
        <p className="text-sm text-[var(--text-sub)] max-w-3xl">
          Reusable named secrets. A <strong>managed value</strong> is encrypted before persistence and can never be
          displayed after saving; a <strong>Vault reference</strong> links a trusted KV path without copying its value.
          Consumers select entries by name and stable id.
        </p>
      </header>

      <AlertBanner variant="info" title="Write-only by design">
        Secret values are never returned to this screen, the API, logs or HTML. Rotation replaces a value
        intentionally; there is no readback and no “show secret”.
      </AlertBanner>

      {notice !== null ? (
        <AlertBanner variant="success" title="Saved">
          {notice}
          <Button type="button" variant="link" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>
        </AlertBanner>
      ) : null}

      <Card>
        <CardHeader className="gap-1">
          <CardTitle>Catalog</CardTitle>
          <CardDescription>Tenant-scoped entries. Listing a name never grants resolving its value.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full max-w-sm">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-[var(--text-sub)]">Active Tenant</span>
                <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)] text-sm">
                  <span className="font-medium text-[var(--text-main)] truncate">
                    {tenant?.name || (tenantScope ? `Tenant (${tenantScope.slice(0, 8)}...)` : 'No Tenant Selected')}
                  </span>
                  {tenant && (
                    <Badge variant={tenant.state === 'ACTIVE' ? 'success' : 'neutral'} className="text-[10px] py-0 px-1.5 ml-auto">
                      {tenant.state}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-[var(--text-sub)]">Inherited from Global Tenant in Left Navigator.</p>
              </div>
            </div>
            <Button type="button" variant="outline" onClick={() => void load()} isLoading={loading}>
              Refresh
            </Button>
            <Button type="button" onClick={() => { setCreateDraft(emptyCreateDraft()); setCreateError(null); setCreateOpen(true); }}>
              New secret
            </Button>
          </div>

          <StatePanel
            state={state}
            loadingProps={{ title: 'Loading secrets…', description: 'Reading catalog metadata for the current tenant scope.' }}
            emptyProps={{
              title: 'No secrets yet',
              description: 'Create a managed value or link a trusted Vault KV path. Consumers can then select it by name.',
            }}
            errorProps={{
              title: problem?.title ?? 'The secret catalog could not be loaded',
              description: problem?.code === 'UPSTREAM_UNAVAILABLE' || problem?.code === 'UPSTREAM_ERROR'
                ? 'The secret catalog backend is not available on this deployment yet. The screen stays honest: nothing was fabricated.'
                : undefined,
              statusCode: problem?.status,
            }}
          >
            <TableContainer>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Services</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Revision</TableHead>
                    <TableHead>Usage</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const test = testResults[entry.secretId];
                    return (
                      <TableRow key={entry.secretId}>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <span className="font-medium text-[var(--text-main)]">{entry.name}</span>
                            <span className="font-mono text-xs text-[var(--text-sub)]">{entry.secretId}</span>
                            {entry.provider.kind === 'managed_value' ? (
                              <span>
                                <Badge variant={entry.valueConfigured ? 'info' : 'warning'}>
                                  {entry.valueConfigured ? 'value configured' : 'no value yet'}
                                </Badge>
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{entry.purpose}</TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <span className="text-sm">{providerLabel(entry.provider)}</span>
                            <span className="font-mono text-xs text-[var(--text-sub)]">{providerDetail(entry.provider)}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{entry.services.join(', ')}</TableCell>
                        <TableCell>
                          <Badge variant={secretStateVariant(entry.state)} dot>{entry.state}</Badge>
                        </TableCell>
                        <TableCell className="tabular-nums text-sm">{entry.revision}</TableCell>
                        <TableCell className="text-xs">
                          {entry.usageReferences.length === 0
                            ? 'unused'
                            : entry.usageReferences.map((usage) => `${usage.kind}:${usage.refId}`).join(', ')}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-2">
                            <div className="flex flex-wrap gap-1">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={entry.state !== 'ACTIVE' || entry.provider.kind !== 'managed_value'}
                                title={entry.provider.kind !== 'managed_value'
                                  ? 'Vault references rotate in Vault, not here'
                                  : 'Replace the managed value'}
                                onClick={() => { setRotateTarget(entry); setRotateValue(''); setRotateError(null); }}
                              >
                                Rotate
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={entry.state !== 'ACTIVE'}
                                onClick={() => { setDisableTarget(entry); setDisableReason(''); setDisableError(null); }}
                              >
                                Disable
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                isLoading={test === 'pending'}
                                onClick={() => void runTest(entry)}
                              >
                                Test
                              </Button>
                            </div>
                            {test !== undefined && test !== 'pending' ? (
                              <Badge variant={test.ok ? 'success' : 'danger'} dot role="status">
                                {test.ok ? 'available' : `unavailable: ${test.errorCode ?? 'unknown'}`}
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </StatePanel>
        </CardContent>
      </Card>

      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New secret"
        description="Managed values are encrypted before persistence; Vault links point at a trusted KV path. Values are write-only."
        maxWidth="max-w-2xl"
        footer={(
          <>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              type="button"
              isLoading={busy}
              disabled={
                createDraft.name.trim().length === 0
                || tenantScope.trim().length === 0
                || (createDraft.providerKind === 'managed_value' && createDraft.value.length === 0)
                || (createDraft.providerKind === 'vault_reference'
                  && (createDraft.connectionId.trim().length === 0 || createDraft.path.trim().length === 0 || createDraft.field.trim().length === 0))
                // SC-03 / F6: an unparsable pinned version must block Save so
                // the payload can never carry version: null.
                || pinnedVersionInvalid
              }
              onClick={() => void submitCreate()}
            >
              Save secret
            </Button>
          </>
        )}
      >
        <div className="flex flex-col gap-4">
          {createError !== null ? (
            <AlertBanner variant="error" title={createError.title}>
              {createError.code} (HTTP {createError.status})
              {createError.errors && createError.errors.length > 0 ? (
                <ul className="mt-1 list-disc pl-4">
                  {createError.errors.map((issue) => (
                    <li key={issue.pointer}>{issue.pointer}: {issue.message}</li>
                  ))}
                </ul>
              ) : null}
            </AlertBanner>
          ) : null}
          <FormField id="secret-name" label="Display name" required>
            <Input
              id="secret-name"
              value={createDraft.name}
              onChange={(event) => updateCreate((draft) => ({ ...draft, name: event.target.value }))}
              placeholder="e.g. billing webhook token"
            />
          </FormField>
          <FormField id="secret-purpose" label="Purpose" required description="Which feature may resolve this entry.">
            <NativeSelect
              id="secret-purpose"
              value={createDraft.purpose}
              onChange={(event) => updateCreate((draft) => ({ ...draft, purpose: event.target.value as SecretPurpose }))}
            >
              {SECRET_PURPOSES.map((purpose) => (
                <option key={purpose} value={purpose}>{purpose}</option>
              ))}
            </NativeSelect>
          </FormField>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-semibold text-[var(--text-main)]">Allowed services</legend>
            <div className="flex flex-wrap gap-4">
              {SECRET_SERVICES.map((service) => (
                <label key={service} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={createDraft.services.includes(service)}
                    onChange={(event) => updateCreate((draft) => ({
                      ...draft,
                      services: event.target.checked
                        ? [...draft.services, service]
                        : draft.services.filter((item) => item !== service),
                    }))}
                  />
                  {service}
                </label>
              ))}
            </div>
          </fieldset>
          <FormField id="secret-provider" label="Provider" required>
            <div role="radiogroup" aria-label="Secret provider" className="flex flex-wrap gap-2">
              <Button
                type="button" size="sm" role="radio" aria-checked={createDraft.providerKind === 'managed_value'}
                variant={createDraft.providerKind === 'managed_value' ? 'primary' : 'outline'}
                onClick={() => updateCreate((draft) => ({ ...draft, providerKind: 'managed_value' }))}
              >
                Managed value
              </Button>
              <Button
                type="button" size="sm" role="radio" aria-checked={createDraft.providerKind === 'vault_reference'}
                variant={createDraft.providerKind === 'vault_reference' ? 'primary' : 'outline'}
                onClick={() => updateCreate((draft) => ({ ...draft, providerKind: 'vault_reference' }))}
              >
                Vault reference
              </Button>
            </div>
          </FormField>

          {createDraft.providerKind === 'managed_value' ? (
            <FormField
              id="secret-value"
              label="Value (write-only)"
              required
              description="Encrypted before persistence. It is never displayed, logged or returned by any read."
            >
              <Input
                id="secret-value"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={createDraft.value}
                onChange={(event) => updateCreate((draft) => ({ ...draft, value: event.target.value }))}
                placeholder="Enter the secret value"
              />
            </FormField>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField id="vault-connection" label="Connection id" required>
                <Input id="vault-connection" value={createDraft.connectionId}
                  onChange={(event) => updateCreate((draft) => ({ ...draft, connectionId: event.target.value }))} />
              </FormField>
              <FormField id="vault-mount" label="Mount" required>
                <Input id="vault-mount" value={createDraft.mount}
                  onChange={(event) => updateCreate((draft) => ({ ...draft, mount: event.target.value }))} />
              </FormField>
              <FormField id="vault-path" label="Logical path" required description="Relative path, e.g. du/tenants/…/billing">
                <Input id="vault-path" value={createDraft.path}
                  onChange={(event) => updateCreate((draft) => ({ ...draft, path: event.target.value }))} />
              </FormField>
              <FormField id="vault-field" label="Field" required>
                <Input id="vault-field" value={createDraft.field}
                  onChange={(event) => updateCreate((draft) => ({ ...draft, field: event.target.value }))} />
              </FormField>
              <FormField id="vault-namespace" label="Namespace (optional)">
                <Input id="vault-namespace" value={createDraft.namespace}
                  onChange={(event) => updateCreate((draft) => ({ ...draft, namespace: event.target.value }))} />
              </FormField>
              <FormField
                id="vault-version"
                label="Version"
                description="Pinned is safest; latest follows Vault."
                error={pinnedVersionInvalid ? 'Enter a whole number of 1 or more.' : undefined}
              >
                <div className="flex gap-2">
                  <NativeSelect
                    id="vault-version-mode"
                    value={createDraft.versionMode}
                    onChange={(event) => updateCreate((draft) => ({ ...draft, versionMode: event.target.value as 'pinned' | 'latest' }))}
                  >
                    <option value="pinned">pinned</option>
                    <option value="latest">latest</option>
                  </NativeSelect>
                  {createDraft.versionMode === 'pinned' ? (
                    <Input
                      id="vault-version-number"
                      type="number"
                      min={1}
                      value={createDraft.version}
                      onChange={(event) => updateCreate((draft) => ({ ...draft, version: event.target.value }))}
                    />
                  ) : null}
                </div>
              </FormField>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={rotateTarget !== null}
        onOpenChange={(open) => { if (!open) setRotateTarget(null); }}
        title={rotateTarget !== null ? `Rotate '${rotateTarget.name}'` : 'Rotate secret'}
        description="The new value is write-only. The previous value stops resolving after rotation."
        footer={(
          <>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setRotateTarget(null)}>Cancel</Button>
            <Button type="button" variant="destructive" isLoading={busy} disabled={rotateValue.length === 0}
              onClick={() => void submitRotate()}>
              Rotate value
            </Button>
          </>
        )}
      >
        <div className="flex flex-col gap-3">
          {rotateError !== null ? (
            <AlertBanner variant="error" title={rotateError.title}>
              {rotateError.code} (HTTP {rotateError.status})
            </AlertBanner>
          ) : null}
          <FormField id="rotate-value" label="New value (write-only)" required>
            <Input
              id="rotate-value"
              type="password"
              autoComplete="off"
              value={rotateValue}
              onChange={(event) => setRotateValue(event.target.value)}
            />
          </FormField>
        </div>
      </Modal>

      <Modal
        open={disableTarget !== null}
        onOpenChange={(open) => { if (!open) setDisableTarget(null); }}
        title={disableTarget !== null ? `Disable '${disableTarget.name}'` : 'Disable secret'}
        description="Disabled entries stop resolving immediately; consumers fail closed."
        footer={(
          <>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setDisableTarget(null)}>Cancel</Button>
            <Button type="button" variant="destructive" isLoading={busy} disabled={disableReason.trim().length === 0}
              onClick={() => void submitDisable()}>
              Disable secret
            </Button>
          </>
        )}
      >
        <div className="flex flex-col gap-3">
          {disableError !== null ? (
            <AlertBanner variant="error" title={disableError.title}>
              {disableError.code} (HTTP {disableError.status})
            </AlertBanner>
          ) : null}
          <FormField id="disable-reason" label="Reason" required>
            <Input id="disable-reason" value={disableReason}
              onChange={(event) => setDisableReason(event.target.value)}
              placeholder="e.g. rotated out after provider migration" />
          </FormField>
        </div>
      </Modal>
    </section>
  );
}
