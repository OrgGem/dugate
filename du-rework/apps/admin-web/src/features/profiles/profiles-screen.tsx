import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/dialog';
import { AlertBanner, DeniedState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import {
  createAdminApiClient,
  type AdminApiProblem,
  type ConnectionStep,
  type FileUrlAuthConfigWrite,
  type ProfileDetail,
  type RequestRedactionRule,
} from '@/lib/api';
import { profileErrorHint, parseProfileDetail } from './state';
import { buildPublishBody, buildRollbackBody, buildUpsertBody } from './command-bodies';
import { RequestRedactionEditor } from './request-redaction-editor';
import { CallbackPolicyEditor } from './callback-policy-editor';
import { buildCallbackPolicy, callbackPolicyFromRead, emptyCallbackDraft, validateCallbackDraft, type CallbackDraft } from './callback-policy';
import { parseSecretListPage } from '@/features/secrets/state';
import type { SecretOption } from '@/features/secrets/value-source-selector';
import { BusinessInputs } from '@/features/businesses/business-inputs';

type Priority = 'LOW' | 'MEDIUM' | 'HIGH';
type FileUrlAuthType = 'none' | 'bearer' | 'header' | 'query';

interface ParamDraft {
  key: string;
  value: string;
  isLocked: boolean;
}

/**
 * UI-internal draft row (NOT part of the frozen read wire). The loaded detail
 * seeds one row from its single `policy`; operators may add more rows to bulk
 * upsert several profile keys in one pass (T-UI-04).
 */
interface RowDraft {
  profileName: string;
  enabled: boolean;
  jobPriority: Priority;
  extensionsCsv: string;
  params: ParamDraft[];
  connSteps: ConnectionStep[];
  requestRedaction: RequestRedactionRule[];
  /** CB-04: null = inherit (absent policy preserves notification-only). */
  callback: CallbackDraft | null;
}

interface FileUrlAuthDraft {
  touched: boolean;
  type: FileUrlAuthType;
  token: string;
  header_name: string;
  header_value: string;
  query_key: string;
  query_value: string;
}

interface Draft {
  rows: RowDraft[];
  fileUrlAuth: FileUrlAuthDraft;
  prompt: { connectionId: string; apiKeyId: string; endpointSlug: string; stepId: string; text: string; isActive: boolean };
}

interface RowResult {
  profileName: string;
  ok: boolean;
  detail: string;
}

/**
 * Profile vertical slice (AWEB-04) — conformant with the frozen Phase-1 wire:
 * read = `{businessId, businessVersion, profileName, revision, currentValues,
 * policy, manifest, capabilities:[{connectorId, capability}]}`; writes ride
 * `/admin/api/profiles/…/{upsert|publish|rollback}` → dispatcher.
 */
export function ProfilesScreen() {
  const client = useMemo(() => createAdminApiClient(), []);
  const [businessId, setBusinessId] = useState('');
  const [businessVersion, setBusinessVersion] = useState('latest');
  const [profileName, setProfileName] = useState('new');

  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [loadedAs, setLoadedAs] = useState<{ businessId: string; businessVersion: string; profileName: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<AdminApiProblem | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowResults, setRowResults] = useState<RowResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testFileUrls, setTestFileUrls] = useState('');
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [testProblem, setTestProblem] = useState<AdminApiProblem | null>(null);
  const [secretOptions, setSecretOptions] = useState<SecretOption[]>([]);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [secretsProblem, setSecretsProblem] = useState<AdminApiProblem | null>(null);

  // CB-04: the callback credential fields select from the live secret
  // catalog; a catalog outage degrades the selector with an honest message and
  // never blocks profile editing.
  useEffect(() => {
    let active = true;
    setSecretsLoading(true);
    void client.listSecrets({ limit: '100' }).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setSecretOptions([]);
        setSecretsProblem(result.problem);
        setSecretsLoading(false);
        return;
      }
      const page = parseSecretListPage(result.data);
      if (page === null) {
        setSecretOptions([]);
        setSecretsProblem({ status: 502, code: 'UNREADABLE_RESPONSE', title: 'The secret catalog response did not match the contract.' });
        setSecretsLoading(false);
        return;
      }
      setSecretOptions(page.items.map((entry) => ({
        secretId: entry.secretId,
        name: entry.name,
        state: entry.state,
        purpose: entry.purpose,
      })));
      setSecretsProblem(null);
      setSecretsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [client]);

  const identifiers = { businessId: businessId.trim(), businessVersion: businessVersion.trim() || 'latest', profileName: profileName.trim() || 'new' };

  async function load(): Promise<void> {
    setLoading(true);
    setProblem(null);
    setNotice(null);
    setRowResults(null);
    try {
      const sessionResult = await client.getSession();
      if (!sessionResult.ok) {
        setDetail(null);
        setDraft(null);
        setLoadedAs(null);
        setProblem(sessionResult.problem);
        return;
      }
      const result = await client.getProfile(identifiers.businessId, identifiers.businessVersion, identifiers.profileName);
      if (!result.ok) {
        setDetail(null);
        setDraft(null);
        setProblem(result.problem);
        return;
      }
      const parsed = parseProfileDetail(result.data);
      if (parsed === null) {
        setDetail(null);
        setDraft(null);
        setProblem({ status: 502, code: 'UNREADABLE_RESPONSE', title: 'Unreadable profile payload.' });
        return;
      }
      setDetail(parsed);
      setLoadedAs(identifiers);
      setDraft(draftFromDetail(parsed));
    } finally {
      setLoading(false);
    }
  }

  const caps = detail?.capabilities ?? [];
  const policyShipped = caps.length > 0;
  const hasCapability = (name: string): boolean => caps.some((capability) => capability.capability === name);
  const canTest = hasCapability('testEndpoint');
  const canPublish = hasCapability('publish');
  const canRollback = hasCapability('rollback');

  function updateDraft(mutate: (current: Draft) => Draft): void {
    setDraft((current) => (current === null ? current : mutate(current)));
  }

  function updateRow(index: number, next: RowDraft): void {
    updateDraft((d) => ({ ...d, rows: d.rows.map((row, i) => (i === index ? next : row)) }));
  }

  function buildPolicy(row: RowDraft): Record<string, unknown> {
    const parameters: Record<string, { value: unknown }> = {};
    for (const param of row.params) {
      if (param.isLocked) continue; // locked slots are omitted entirely (server 400s presence)
      parameters[param.key] = { value: param.value };
    }
    const policy: Record<string, unknown> = {
      enabled: row.enabled,
      parameters,
      jobPriority: row.jobPriority,
      allowedFileExtensions: row.extensionsCsv,
      connectionsOverride: row.connSteps,
      requestRedaction: row.requestRedaction,
    };
    if (draft !== null && draft.fileUrlAuth.touched) {
      policy.fileUrlAuthConfig = buildFileUrlAuth(draft.fileUrlAuth);
    }
    if (row.callback !== null && row.callback.touched) {
      const callbackPolicy = buildCallbackPolicy(row.callback);
      if (callbackPolicy !== null) policy.callbackPolicy = callbackPolicy;
    }
    return policy;
  }

  async function saveRow(row: RowDraft): Promise<{ result: RowResult; problem?: AdminApiProblem }> {
    const target = loadedAs;
    if (detail === null || target === null) {
      return { result: { profileName: row.profileName, ok: false, detail: 'no profile loaded' } };
    }
    const profileKey = row.profileName.trim() || target.profileName;
    if (row.callback !== null && row.callback.touched) {
      const callbackErrors = validateCallbackDraft(row.callback);
      if (callbackErrors.length > 0) {
        return {
          result: {
            profileName: profileKey,
            ok: false,
            detail: `callback policy invalid: ${callbackErrors[0] ?? 'configuration error'}`,
          },
        };
      }
    }
    const response = await client.upsertProfile(
      target.businessId,
      target.businessVersion,
      profileKey,
      buildUpsertBody(detail, buildPolicy(row)),
      crypto.randomUUID(),
    );
    if (response.ok) {
      return { result: { profileName: profileKey, ok: true, detail: `saved (revision ${response.data.revision ?? '?'})` } };
    }
    return {
      result: { profileName: profileKey, ok: false, detail: `${response.status} · ${response.problem.code ?? 'ERROR'}` },
      problem: response.problem,
    };
  }

  async function saveOne(row: RowDraft): Promise<void> {
    setBusy(true);
    setNotice(null);
    setRowResults(null);
    setProblem(null);
    try {
      const { result, problem: failure } = await saveRow(row);
      if (result.ok) {
        await load();
        setRowResults([result]);
        setNotice('Saved — reloading the persisted revision.');
      } else {
        setRowResults([result]);
        if (failure !== undefined) setProblem(failure);
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveAll(): Promise<void> {
    if (draft === null) return;
    setBusy(true);
    setNotice(null);
    setProblem(null);
    try {
      // T-UI-04 / R-04: one POST per row, Promise.allSettled, per-row reporting,
      // no common rollback of the rows that did persist.
      const settled = await Promise.allSettled(draft.rows.map((row) => saveRow(row)));
      const rows: RowResult[] = settled.map((entry, index) =>
        entry.status === 'fulfilled'
          ? entry.value.result
          : { profileName: draft.rows[index]?.profileName ?? '?', ok: false, detail: 'transport error' },
      );
      if (rows.some((row) => row.ok)) {
        await load();
        setRowResults(rows);
        setNotice('Partial save: the rows that succeeded stay persisted; failed rows are listed above.');
      } else {
        setRowResults(rows);
        const firstFailure = settled.find(
          (entry): entry is PromiseFulfilledResult<{ result: RowResult; problem?: AdminApiProblem }> =>
            entry.status === 'fulfilled' && entry.value.problem !== undefined,
        );
        if (firstFailure?.value.problem !== undefined) setProblem(firstFailure.value.problem);
      }
    } finally {
      setBusy(false);
    }
  }

  async function publish(): Promise<void> {
    if (detail === null || loadedAs === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await client.publishProfile(
        loadedAs.businessId,
        loadedAs.businessVersion,
        loadedAs.profileName,
        buildPublishBody(detail),
        crypto.randomUUID(),
      );
      if (result.ok) {
        await load();
        setNotice(`Published (revision ${result.data.revision ?? '?'}).`);
      } else {
        setProblem(result.problem);
      }
    } finally {
      setBusy(false);
    }
  }

  async function rollback(target: number): Promise<void> {
    if (detail === null || loadedAs === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await client.rollbackProfile(
        loadedAs.businessId,
        loadedAs.businessVersion,
        loadedAs.profileName,
        buildRollbackBody(detail, target),
        crypto.randomUUID(),
      );
      if (result.ok) {
        await load();
        setNotice(`Rolled back (active revision ${result.data.revision ?? '?'}).`);
      } else {
        setProblem(result.problem);
      }
    } finally {
      setBusy(false);
    }
  }

  async function applyPromptOverride(): Promise<void> {
    if (draft === null) return;
    setNotice(null);
    setProblem(null);
    const result = await client.postAction(
      'prompt-override.upsert',
      {
        connectionId: draft.prompt.connectionId,
        apiKeyId: draft.prompt.apiKeyId,
        endpointSlug: draft.prompt.endpointSlug,
        stepId: draft.prompt.stepId || '_default',
        promptOverride: draft.prompt.text,
        isActive: draft.prompt.isActive,
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    if (result.ok) {
      setNotice('Prompt override submitted.');
    } else {
      setProblem(result.problem);
    }
  }

  async function runTestEndpoint(): Promise<void> {
    if (detail === null || draft === null || loadedAs === null) return;
    setTestResult(null);
    setTestProblem(null);
    const row = draft.rows[0];
    const parameters: Record<string, { value: unknown }> = {};
    for (const param of row?.params ?? []) {
      if (!param.isLocked) parameters[param.key] = { value: param.value };
    }
    const result = await client.testProfileEndpoint(
      {
        businessId: loadedAs.businessId,
        businessVersion: loadedAs.businessVersion,
        profileName: loadedAs.profileName,
        endpointSlug: row?.profileName ?? '',
        parameters,
        file_urls: testFileUrls.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
      },
      crypto.randomUUID(),
    );
    if (result.ok) setTestResult(result.data);
    else setTestProblem(result.problem);
  }

  return (
    <section aria-labelledby="profiles-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="profiles-title" className="text-lg font-semibold">
          Profiles
        </h1>
        <Badge variant="neutral">PAR-12 + PAR-13 slice</Badge>
        {!policyShipped && detail !== null ? (
          <Badge variant="warning" dot>
            policy backend not shipped (T-API-01..03)
          </Badge>
        ) : null}
      </div>

      <AlertBanner variant="info" title="Wire frozen (Phase-1 contract)">
        Reads use the frozen shape <code>{'{revision, currentValues, policy, manifest, capabilities:[{connectorId, capability}]}'}</code>;
        writes ride <code>/admin/api/profiles/…</code> → dispatcher (<code>profile.upsert</code>/
        <code>publish</code>/<code>rollback</code>). Until T-API-02 lands the dispatcher answers{' '}
        <code>404 ACTION_NOT_FOUND</code> and actions stay disabled — nothing is faked here.
      </AlertBanner>

      <Card>
        <CardHeader>
          <CardTitle>Profile selector</CardTitle>
          <CardDescription>GET /admin/api/profiles/:businessId/:version/:profile (T-UI-05 fence).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <BusinessInputs businessInputId="profile-business" versionInputId="profile-version" businessId={businessId} businessVersion={businessVersion} onBusinessChange={setBusinessId} onVersionChange={setBusinessVersion} />
          <div className="w-full max-w-[12rem]">
            <FormField id="profile-name" label="Profile">
              <Input id="profile-name" value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="new" />
            </FormField>
          </div>
          <Button onClick={() => void load()} isLoading={loading} disabled={identifiers.businessId.length === 0}>
            Load profile
          </Button>
        </CardContent>
      </Card>

      {problem !== null && detail === null ? (
        problem.status === 403 ? (
          <DeniedState
            title="Access denied"
            description={profileErrorHint(problem.code) ?? problem.title ?? 'This session is not authorized for the Profile screen.'}
          />
        ) : (
          <ErrorState
            title={problem.title ?? 'The Profile API rejected the request.'}
            statusCode={problem.status}
            error={problem.code}
            onRetry={identifiers.businessId.length > 0 ? () => void load() : undefined}
          />
        )
      ) : null}

      {problem !== null && detail !== null ? (
        <AlertBanner variant="error" title={problem.title ?? 'The Profile API rejected the request.'}>
          {problem.status} · {problem.code ?? 'ERROR'}
          {profileErrorHint(problem.code) ? <> — {profileErrorHint(problem.code)}</> : null}
        </AlertBanner>
      ) : null}
      {notice !== null ? (
        <AlertBanner variant="success" title="Profile">
          {notice}
        </AlertBanner>
      ) : null}

      {loading ? <LoadingState title="Loading profile…" /> : null}

      {detail !== null && draft !== null ? (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>
                  {detail.businessId}@{detail.businessVersion} · {detail.profileName || '(new)'}
                </CardTitle>
                <Badge variant="neutral">revision {detail.revision}</Badge>
                {caps.length === 0 ? <Badge variant="warning" dot>no capabilities reported</Badge> : null}
                {caps.slice(0, 6).map((capability) => (
                  <Badge key={`${capability.connectorId}:${capability.capability}`} variant="info">
                    {capability.connectorId}:{capability.capability}
                  </Badge>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              {rowResults !== null ? (
                <div className="mb-3">
                  <AlertBanner variant={rowResults.every((r) => r.ok) ? 'success' : 'warning'} title="Bulk save results (per row)">
                    <ul>
                      {rowResults.map((row) => (
                        <li key={row.profileName}>
                          <code>{row.profileName}</code>: {row.ok ? 'OK' : 'FAILED'} — {row.detail}
                        </li>
                      ))}
                    </ul>
                  </AlertBanner>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void saveAll()} disabled={!policyShipped || busy} title={policyShipped ? 'Save all rows (per-row results)' : 'Policy backend not shipped (T-API-02)'}>
                  Save all endpoints
                </Button>
                <Button variant="outline" onClick={() => void publish()} disabled={!canPublish || busy} title={canPublish ? 'Publish' : 'Publish capability not reported'}>
                  Publish
                </Button>
                <Button variant="outline" onClick={() => void rollback(Math.max(1, detail.revision - 1))} disabled={!canRollback || busy || detail.revision < 2} title={canRollback ? 'Rollback to previous revision' : 'Rollback capability not reported'}>
                  Rollback to v{Math.max(1, detail.revision - 1)}
                </Button>
                <Button variant="outline" onClick={() => setTestOpen(true)} disabled={!canTest} title={canTest ? 'Test Endpoint' : 'T-UI-06 gated: POST /api/v1/admin/profile-test-endpoint not shipped'}>
                  Test Endpoint
                </Button>
                <Button
                  variant="secondary"
                  disabled={!policyShipped}
                  onClick={() =>
                    updateDraft((d) => ({
                      ...d,
                      rows: [
                        ...d.rows,
                        { profileName: '', enabled: true, jobPriority: 'MEDIUM', extensionsCsv: '', params: [], connSteps: [], requestRedaction: [], callback: null },
                      ],
                    }))
                  }
                >
                  Add endpoint row
                </Button>
              </div>
            </CardContent>
          </Card>

          {draft.rows.map((row, rowIndex) => (
            <Card key={`row-${rowIndex}`}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    aria-label="row profile name"
                    className="w-full max-w-[12rem]"
                    value={row.profileName}
                    disabled={!policyShipped}
                    onChange={(e) => updateRow(rowIndex, { ...row, profileName: e.target.value })}
                    placeholder="profile / endpoint"
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      disabled={!policyShipped}
                      onChange={(e) => updateRow(rowIndex, { ...row, enabled: e.target.checked })}
                    />{' '}
                    enabled
                  </label>
                </div>
                <CardDescription>Locked slots are display-only; the server rejects a locked field even when unchanged.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-3">
                  <div className="w-full max-w-[10rem]">
                    <FormField id={`priority-${rowIndex}`} label="Job priority">
                      <select
                        id={`priority-${rowIndex}`}
                        className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm"
                        value={row.jobPriority}
                        disabled={!policyShipped}
                        onChange={(e) => updateRow(rowIndex, { ...row, jobPriority: e.target.value as Priority })}
                      >
                        <option value="LOW">LOW (queue 20)</option>
                        <option value="MEDIUM">MEDIUM (queue 10)</option>
                        <option value="HIGH">HIGH (queue 1)</option>
                      </select>
                    </FormField>
                  </div>
                  <div className="w-full max-w-sm">
                    <FormField id={`ext-${rowIndex}`} label="Allowed file extensions (CSV)">
                      <Input
                        id={`ext-${rowIndex}`}
                        value={row.extensionsCsv}
                        disabled={!policyShipped}
                        onChange={(e) => updateRow(rowIndex, { ...row, extensionsCsv: e.target.value })}
                        placeholder=".pdf,.docx"
                      />
                    </FormField>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <strong className="text-sm">Parameters</strong>
                  {row.params.length === 0 ? (
                    <p className="text-xs text-[var(--text-sub)]">No parameters in this policy.</p>
                  ) : null}
                  {row.params.map((param, paramIndex) => (
                    <div key={param.key} className="flex flex-wrap items-center gap-2">
                      <code className="text-xs w-full max-w-[14rem] break-all">{param.key}</code>
                      <Input
                        aria-label={`value ${param.key}`}
                        value={param.value}
                        readOnly={param.isLocked}
                        disabled={param.isLocked || !policyShipped}
                        data-locked={param.isLocked ? 'true' : undefined}
                        className="w-full max-w-sm"
                        onChange={(e) =>
                          updateRow(rowIndex, {
                            ...row,
                            params: row.params.map((p, i) => (i === paramIndex ? { ...p, value: e.target.value } : p)),
                          })
                        }
                      />
                      {param.isLocked ? (
                        <Badge variant="neutral" dot>
                          locked
                        </Badge>
                      ) : null}
                    </div>
                  ))}
                </div>

                <div className="flex flex-col gap-2">
                  <strong className="text-sm">Connections override (ConnectionStep[])</strong>
                  {row.connSteps.map((step, stepIndex) => (
                    <div key={`${step.slug}:${stepIndex}`} className="flex flex-wrap items-center gap-2 text-xs">
                      <code>{step.slug}</code>
                      {step.stepId ? <span>step {step.stepId}</span> : null}
                      {step.captureSession ? <Badge variant="info">capture</Badge> : null}
                      {step.injectSession ? <Badge variant="info">inject</Badge> : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!policyShipped}
                        onClick={() => updateRow(rowIndex, { ...row, connSteps: row.connSteps.filter((_, i) => i !== stepIndex) })}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <div className="flex flex-wrap items-end gap-2">
                    <Input id={`step-slug-${rowIndex}`} aria-label="connection slug" placeholder="connection slug" className="w-full max-w-[12rem]" disabled={!policyShipped} />
                    <Input id={`step-id-${rowIndex}`} aria-label="step id" placeholder="stepId (optional)" className="w-full max-w-[10rem]" disabled={!policyShipped} />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!policyShipped}
                      onClick={() => {
                        const slugInput = document.getElementById(`step-slug-${rowIndex}`) as HTMLInputElement | null;
                        const stepInput = document.getElementById(`step-id-${rowIndex}`) as HTMLInputElement | null;
                        const slug = slugInput?.value.trim() ?? '';
                        if (slug.length === 0) return;
                        updateRow(rowIndex, {
                          ...row,
                          connSteps: [...row.connSteps, { slug, ...(stepInput?.value.trim() ? { stepId: stepInput.value.trim() } : {}) }],
                        });
                      }}
                    >
                      Add step
                    </Button>
                  </div>
                </div>

                <RequestRedactionEditor rules={row.requestRedaction} disabled={!policyShipped || busy}
                  onChange={rules => updateRow(rowIndex, { ...row, requestRedaction: rules })} />

                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle>Callback policy (CB-04)</CardTitle>
                      <Badge variant="info" dot>secrets stay server-side</Badge>
                    </div>
                    <CardDescription>
                      Delivery mode and outbound authentication for this profile&apos;s endpoint callbacks. Credentials
                      are catalog secret references only — no literal secret is ever typed into or read from this form.
                      Leaving the policy unchecked preserves the existing notification-only behavior.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <label className="flex items-center gap-2 text-sm text-[var(--text-main)]">
                      <input
                        type="checkbox"
                        checked={row.callback !== null}
                        disabled={!policyShipped || busy}
                        onChange={(event) => updateRow(rowIndex, {
                          ...row,
                          callback: event.target.checked ? emptyCallbackDraft() : null,
                        })}
                      />
                      Configure a callback policy for this profile
                    </label>
                    {row.callback !== null ? (
                      <CallbackPolicyEditor
                        draft={row.callback}
                        onChange={(callback) => updateRow(rowIndex, { ...row, callback })}
                        secrets={secretOptions}
                        secretsLoading={secretsLoading}
                        secretsProblem={secretsProblem}
                        disabled={!policyShipped || busy}
                      />
                    ) : (
                      <p className="text-xs text-[var(--text-sub)]">
                        No callback policy is attached: the platform keeps the existing notification-only delivery
                        (submission callback URL + HMAC signature).
                      </p>
                    )}
                  </CardContent>
                </Card>

                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    disabled={busy || draft.rows.length < 2}
                    onClick={() =>
                      updateDraft((d) => ({ ...d, rows: d.rows.filter((_, i) => i !== rowIndex) }))
                    }
                  >
                    Remove row
                  </Button>
                  <Button
                    onClick={() => void saveOne(row)}
                    disabled={!policyShipped || busy}
                    title={policyShipped ? 'Save row' : 'Policy backend not shipped (T-API-02)'}
                  >
                    Save {row.profileName.trim() || '(unnamed)'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>fileUrlAuthConfig (write-only)</CardTitle>
                <Badge variant="warning" dot>
                  write-only · snake_case
                </Badge>
                {detail.policy.fileUrlAuthConfigured ? <Badge variant="info">configured on server</Badge> : null}
              </div>
              <CardDescription>
                Encrypted server-side (AES-256-GCM, T-PROF-04); the read wire never returns it. Fields below follow the
                frozen legacy shape and are sent only when touched — nothing is stored in the browser.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="w-full max-w-[10rem]">
                <FormField id="fua-type" label="type">
                  <select
                    id="fua-type"
                    className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm"
                    value={draft.fileUrlAuth.type}
                    disabled={!policyShipped}
                    onChange={(e) =>
                      updateDraft((d) => ({
                        ...d,
                        fileUrlAuth: { ...d.fileUrlAuth, touched: true, type: e.target.value as FileUrlAuthType },
                      }))
                    }
                  >
                    <option value="none">none</option>
                    <option value="bearer">bearer</option>
                    <option value="header">header</option>
                    <option value="query">query</option>
                  </select>
                </FormField>
              </div>
              {draft.fileUrlAuth.type === 'bearer' ? (
                <div className="w-full max-w-sm">
                  <FormField id="fua-token" label="token">
                    <Input
                      id="fua-token"
                      type="password"
                      value={draft.fileUrlAuth.token}
                      disabled={!policyShipped}
                      onChange={(e) => updateDraft((d) => ({ ...d, fileUrlAuth: { ...d.fileUrlAuth, touched: true, token: e.target.value } }))}
                      placeholder="sent on save, never re-read"
                    />
                  </FormField>
                </div>
              ) : null}
              {draft.fileUrlAuth.type === 'header' ? (
                <>
                  <div className="w-full max-w-[12rem]">
                    <FormField id="fua-header-name" label="header_name">
                      <Input id="fua-header-name" value={draft.fileUrlAuth.header_name} disabled={!policyShipped} onChange={(e) => updateDraft((d) => ({ ...d, fileUrlAuth: { ...d.fileUrlAuth, touched: true, header_name: e.target.value } }))} />
                    </FormField>
                  </div>
                  <div className="w-full max-w-sm">
                    <FormField id="fua-header-value" label="header_value">
                      <Input id="fua-header-value" type="password" value={draft.fileUrlAuth.header_value} disabled={!policyShipped} onChange={(e) => updateDraft((d) => ({ ...d, fileUrlAuth: { ...d.fileUrlAuth, touched: true, header_value: e.target.value } }))} />
                    </FormField>
                  </div>
                </>
              ) : null}
              {draft.fileUrlAuth.type === 'query' ? (
                <>
                  <div className="w-full max-w-[12rem]">
                    <FormField id="fua-query-key" label="query_key">
                      <Input id="fua-query-key" value={draft.fileUrlAuth.query_key} disabled={!policyShipped} onChange={(e) => updateDraft((d) => ({ ...d, fileUrlAuth: { ...d.fileUrlAuth, touched: true, query_key: e.target.value } }))} />
                    </FormField>
                  </div>
                  <div className="w-full max-w-sm">
                    <FormField id="fua-query-value" label="query_value">
                      <Input id="fua-query-value" type="password" value={draft.fileUrlAuth.query_value} disabled={!policyShipped} onChange={(e) => updateDraft((d) => ({ ...d, fileUrlAuth: { ...d.fileUrlAuth, touched: true, query_value: e.target.value } }))} />
                    </FormField>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Prompt override (PAR-13, key-4)</CardTitle>
              <CardDescription>
                Upsert via <code>prompt-override.upsert</code> (dispatcher). Errors are shown honestly until the
                dispatcher case lands.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-3">
                <Input aria-label="connection id" className="w-full max-w-[16rem]" placeholder="connectionId (uuid)" value={draft.prompt.connectionId} onChange={(e) => updateDraft((d) => ({ ...d, prompt: { ...d.prompt, connectionId: e.target.value } }))} />
                <Input aria-label="api key id" className="w-full max-w-[16rem]" placeholder="apiKeyId" value={draft.prompt.apiKeyId} onChange={(e) => updateDraft((d) => ({ ...d, prompt: { ...d.prompt, apiKeyId: e.target.value } }))} />
                <Input aria-label="endpoint slug" className="w-full max-w-[10rem]" placeholder="endpointSlug" value={draft.prompt.endpointSlug} onChange={(e) => updateDraft((d) => ({ ...d, prompt: { ...d.prompt, endpointSlug: e.target.value } }))} />
                <Input aria-label="step id" className="w-full max-w-[10rem]" placeholder="stepId (_default)" value={draft.prompt.stepId} onChange={(e) => updateDraft((d) => ({ ...d, prompt: { ...d.prompt, stepId: e.target.value } }))} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={draft.prompt.isActive} onChange={(e) => updateDraft((d) => ({ ...d, prompt: { ...d.prompt, isActive: e.target.checked } }))} />
                  active (off = delete)
                </label>
              </div>
              <textarea
                aria-label="prompt override"
                className="min-h-24 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] p-3 text-sm"
                value={draft.prompt.text}
                onChange={(e) => updateDraft((d) => ({ ...d, prompt: { ...d.prompt, text: e.target.value } }))}
                placeholder="Prompt override for this (connection, key, endpoint, step)"
              />
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => void applyPromptOverride()}>
                  Apply prompt override
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Effective config preview</CardTitle>
                <Badge variant="warning" dot>
                  requires backend
                </Badge>
              </div>
              <CardDescription>
                Preview requires backend: the frozen read wire carries no <code>effective</code> field (coordinator
                decision #2), so the merged preview waits for a dedicated capability — no sample is synthesised.
              </CardDescription>
            </CardHeader>
          </Card>
        </>
      ) : null}

      <Modal
        open={testOpen}
        onOpenChange={setTestOpen}
        title="Test Endpoint (T-UI-06)"
        description="Runs the pipeline with the merged profile. Gated on POST /api/v1/admin/profile-test-endpoint."
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setTestOpen(false)}>
              Close
            </Button>
            <Button onClick={() => void runTestEndpoint()} disabled={!canTest}>
              Run test
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <textarea
            aria-label="file urls"
            className="min-h-20 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] p-3 text-sm"
            placeholder="file_urls (one per line)"
            value={testFileUrls}
            onChange={(e) => setTestFileUrls(e.target.value)}
          />
          {testProblem !== null ? (
            <AlertBanner variant="error" title={testProblem.title ?? 'Test Endpoint failed'}>
              {testProblem.status} · {testProblem.code ?? 'ERROR'}
            </AlertBanner>
          ) : null}
          {testResult !== null ? (
            <pre className="max-h-64 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] p-3 text-xs">
              {JSON.stringify(testResult, null, 2)}
            </pre>
          ) : null}
        </div>
      </Modal>
    </section>
  );
}

function buildFileUrlAuth(draft: FileUrlAuthDraft): FileUrlAuthConfigWrite {
  const config: FileUrlAuthConfigWrite = { type: draft.type };
  if (draft.type === 'bearer' && draft.token.length > 0) config.token = draft.token;
  if (draft.type === 'header') {
    if (draft.header_name.length > 0) config.header_name = draft.header_name;
    if (draft.header_value.length > 0) config.header_value = draft.header_value;
  }
  if (draft.type === 'query') {
    if (draft.query_key.length > 0) config.query_key = draft.query_key;
    if (draft.query_value.length > 0) config.query_value = draft.query_value;
  }
  return config;
}

function draftFromDetail(detail: ProfileDetail): Draft {
  const firstAction = detail.manifest.actions[0];
  const seededName = firstAction?.name ?? firstAction?.action ?? detail.profileName ?? 'new';
  const params: ParamDraft[] = Object.entries(detail.policy.parameters).map(([key, parameter]) => ({
    key,
    value: parameter.value === null || parameter.value === undefined ? '' : String(parameter.value),
    isLocked: parameter.isLocked === true,
  }));
  return {
    rows: [
      {
        profileName: seededName,
        enabled: detail.policy.enabled,
        jobPriority: detail.policy.jobPriority,
        extensionsCsv: detail.policy.allowedFileExtensions,
        params,
        connSteps: detail.policy.connectionsOverride,
        requestRedaction: detail.policy.requestRedaction ?? [],
        callback: callbackPolicyFromRead(detail.policy.callbackPolicy),
      },
    ],
    fileUrlAuth: {
      touched: false,
      type: 'none',
      token: '',
      header_name: '',
      header_value: '',
      query_key: '',
      query_value: '',
    },
    prompt: {
      connectionId: '',
      apiKeyId: '',
      endpointSlug: seededName,
      stepId: '_default',
      text: '',
      isActive: true,
    },
  };
}
