import { useMemo } from 'react';
import {
  AlertBanner,
  Badge,
  Button,
  FormField,
  Input,
  NativeSelect,
} from '@/components/ui';
import type { AdminApiProblem, SecretPurpose } from '@/lib/api';
import { ValueSourceSelector, type SecretOption } from '@/features/secrets/value-source-selector';
import {
  CALLBACK_AUTH_METHODS,
  CALLBACK_MAX_HEADERS,
  CALLBACK_MAX_OAUTH2_EXTENSIONS,
  CALLBACK_MODES,
  CALLBACK_SECRET_PURPOSES,
  buildCallbackPolicy,
  emptyCallbackDraft,
  validateCallbackDraft,
  type CallbackDraft,
} from './callback-policy';

/**
 * CB-04 — profile callback policy editor.
 *
 * The credential fields are secret REFERENCES only and reuse the shared
 * ValueSourceSelector in `secretOnly` mode: no literal client secret or header
 * value is ever typed into the browser. The rendered validation mirrors the
 * frozen schema so an operator sees the same rules the server enforces.
 *
 * Every field id is namespaced by `idPrefix` (the row identity) so multiple
 * editors on one screen never share a DOM id; the secret selects are filtered
 * to the frozen callback purposes and keep a configured-but-unavailable ref
 * visible with an explicit Clear.
 */
export interface CallbackPolicyEditorProps {
  /** Unique per editor instance (e.g. `profile-0-callback`). */
  idPrefix: string;
  draft: CallbackDraft;
  onChange: (draft: CallbackDraft) => void;
  secrets: readonly SecretOption[];
  secretsLoading: boolean;
  secretsProblem: AdminApiProblem | null;
  disabled: boolean;
}

function purposeMatches(secret: SecretOption, purpose: SecretPurpose): boolean {
  return secret.purpose === undefined || secret.purpose === purpose;
}

export function CallbackPolicyEditor({
  idPrefix,
  draft,
  onChange,
  secrets,
  secretsLoading,
  secretsProblem,
  disabled,
}: CallbackPolicyEditorProps): React.JSX.Element {
  const validation = useMemo(() => validateCallbackDraft(draft), [draft]);
  // Selectable options: ACTIVE with the exact branch purpose, or missing
  // purpose metadata for compatibility. `generic` is not a callback-purpose
  // wildcard and is filtered out, as are other explicit purposes.
  const headerSecrets = useMemo(
    () => secrets.filter((secret) => secret.state === 'ACTIVE'
      && purposeMatches(secret, CALLBACK_SECRET_PURPOSES.header)),
    [secrets],
  );
  const oauth2Secrets = useMemo(
    () => secrets.filter((secret) => secret.state === 'ACTIVE'
      && purposeMatches(secret, CALLBACK_SECRET_PURPOSES.oauth2ClientSecret)),
    [secrets],
  );
  // Display lookup across every state/purpose, so a stored ref never vanishes.
  const currentFor = (secretId: string | null): SecretOption | null => secretId === null
    ? null
    : secrets.find((secret) => secret.secretId === secretId) ?? null;

  function update(mutate: (current: CallbackDraft) => CallbackDraft): void {
    onChange(mutate(draft));
  }

  function updateHeader(index: number, mutate: (header: CallbackDraft['headers'][number]) => CallbackDraft['headers'][number]): void {
    update((current) => ({
      ...current,
      headers: current.headers.map((header, itemIndex) => (itemIndex === index ? mutate(header) : header)),
    }));
  }

  return (
    <div className="flex flex-col gap-4" data-callback-policy-editor>
      <div className="flex flex-wrap items-center gap-3">
        <FormField id={`${idPrefix}-mode`} label="Mode" className="max-w-xs">
          <NativeSelect
            id={`${idPrefix}-mode`}
            aria-label="Callback mode"
            value={draft.mode}
            disabled={disabled}
            onChange={(event) => update((current) => ({ ...current, mode: event.target.value as CallbackDraft['mode'] }))}
          >
            {CALLBACK_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </NativeSelect>
        </FormField>
        <FormField id={`${idPrefix}-auth`} label="Authentication" className="max-w-xs">
          <NativeSelect
            id={`${idPrefix}-auth`}
            aria-label="Callback authentication"
            value={draft.authMethod}
            disabled={disabled}
            onChange={(event) => update((current) => ({
              ...current,
              authMethod: event.target.value as CallbackDraft['authMethod'],
            }))}
          >
            {CALLBACK_AUTH_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
          </NativeSelect>
        </FormField>
        <label className="flex items-center gap-2 pt-4 text-xs text-[var(--text-sub)]">
          <input
            type="checkbox"
            checked={draft.forceReferenceOnly}
            disabled={disabled}
            onChange={(event) => update((current) => ({ ...current, forceReferenceOnly: event.target.checked }))}
          />
          Reference-only result (no inline payload)
        </label>
      </div>

      {draft.authMethod === 'configured_headers' ? (
        <fieldset className="flex flex-col gap-3" disabled={disabled}>
          <legend className="text-xs font-semibold text-[var(--text-main)]">Configured headers</legend>
          {draft.headers.map((header, index) => (
            <div key={index} className="grid gap-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-3 sm:grid-cols-2">
              <FormField id={`${idPrefix}-header-name-${index}`} label="Header name">
                <Input
                  id={`${idPrefix}-header-name-${index}`}
                  value={header.name}
                  placeholder="X-API-Key"
                  disabled={disabled}
                  onChange={(event) => updateHeader(index, (item) => ({ ...item, name: event.target.value }))}
                />
              </FormField>
              <FormField id={`${idPrefix}-header-prefix-${index}`} label="Optional prefix">
                <Input
                  id={`${idPrefix}-header-prefix-${index}`}
                  value={header.prefix}
                  placeholder="Bearer "
                  disabled={disabled}
                  onChange={(event) => updateHeader(index, (item) => ({ ...item, prefix: event.target.value }))}
                />
              </FormField>
              <div className="sm:col-span-2">
                <ValueSourceSelector
                  idPrefix={`${idPrefix}-header-secret-${index}`}
                  label="Header credential"
                  kind="secret_ref"
                  secretOnly
                  disabled={disabled}
                  required
                  secrets={headerSecrets}
                  currentSecret={currentFor(header.secretId)}
                  secretsLoading={secretsLoading}
                  secretsProblem={secretsProblem?.title ?? null}
                  secretId={header.secretId}
                  stored={header.configuredOnServer && header.secretId !== null && !header.replacing
                    ? { kind: 'secret_ref' }
                    : null}
                  replacing={header.replacing}
                  onRequestReplace={() => updateHeader(index, (item) => ({ ...item, replacing: true }))}
                  onClear={() => updateHeader(index, (item) => ({
                    ...item,
                    secretId: null,
                    configuredOnServer: false,
                    replacing: false,
                  }))}
                  onSecretChange={(secretId) => updateHeader(index, (item) => ({
                    ...item,
                    secretId,
                    replacing: true,
                  }))}
                  literalValue=""
                  onLiteralChange={() => undefined}
                  onKindChange={() => undefined}
                  description="Resolved server-side at delivery time; never sent to the browser."
                  emptyHint={`No active secrets with purpose ${CALLBACK_SECRET_PURPOSES.header} — create one in the Secrets tab first.`}
                />
              </div>
              <div className="sm:col-span-2 flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled || draft.headers.length <= 1}
                  onClick={() => update((current) => ({
                    ...current,
                    headers: current.headers.filter((_item, itemIndex) => itemIndex !== index),
                  }))}
                >
                  Remove header
                </Button>
              </div>
            </div>
          ))}
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || draft.headers.length >= CALLBACK_MAX_HEADERS}
              onClick={() => update((current) => ({
                ...current,
                headers: [...current.headers, {
                  name: '',
                  secretId: null,
                  prefix: '',
                  configuredOnServer: false,
                  replacing: false,
                }],
              }))}
            >
              Add header
            </Button>
          </div>
        </fieldset>
      ) : null}

      {draft.authMethod === 'oauth2_client_credentials' ? (
        <fieldset className="flex flex-col gap-3" disabled={disabled}>
          <legend className="text-xs font-semibold text-[var(--text-main)]">OAuth2 client credentials</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id={`${idPrefix}-token-url`} label="Token URL (https)" required>
              <Input
                id={`${idPrefix}-token-url`}
                value={draft.tokenUrl}
                placeholder="https://provider.example/oauth/token"
                disabled={disabled}
                onChange={(event) => update((current) => ({ ...current, tokenUrl: event.target.value }))}
              />
            </FormField>
            <FormField id={`${idPrefix}-client-id`} label="Client id" required>
              <Input
                id={`${idPrefix}-client-id`}
                value={draft.clientId}
                disabled={disabled}
                onChange={(event) => update((current) => ({ ...current, clientId: event.target.value }))}
              />
            </FormField>
            <FormField id={`${idPrefix}-client-auth`} label="Client authentication" required>
              <NativeSelect
                id={`${idPrefix}-client-auth`}
                value={draft.clientAuthMethod}
                disabled={disabled}
                onChange={(event) => update((current) => ({
                  ...current,
                  clientAuthMethod: event.target.value as CallbackDraft['clientAuthMethod'],
                }))}
              >
                <option value="client_secret_basic">client_secret_basic</option>
                <option value="client_secret_post">client_secret_post</option>
              </NativeSelect>
            </FormField>
            <FormField id={`${idPrefix}-token-lifetime`} label="Token lifetime (seconds, optional)"
              description="Omitted means the token is obtained per delivery; no indefinite cache.">
              <Input
                id={`${idPrefix}-token-lifetime`}
                type="number"
                min={1}
                max={86_400}
                value={draft.tokenLifetimeSeconds}
                disabled={disabled}
                onChange={(event) => update((current) => ({ ...current, tokenLifetimeSeconds: event.target.value }))}
              />
            </FormField>
            <FormField id={`${idPrefix}-scope`} label="Scope (optional)">
              <Input id={`${idPrefix}-scope`} value={draft.scope} disabled={disabled}
                onChange={(event) => update((current) => ({ ...current, scope: event.target.value }))} />
            </FormField>
            <FormField id={`${idPrefix}-audience`} label="Audience (optional)">
              <Input id={`${idPrefix}-audience`} value={draft.audience} disabled={disabled}
                onChange={(event) => update((current) => ({ ...current, audience: event.target.value }))} />
            </FormField>
            <FormField id={`${idPrefix}-resource`} label="Resource (optional)">
              <Input id={`${idPrefix}-resource`} value={draft.resource} disabled={disabled}
                onChange={(event) => update((current) => ({ ...current, resource: event.target.value }))} />
            </FormField>
          </div>
          <ValueSourceSelector
            idPrefix={`${idPrefix}-client-secret`}
            label="Client secret"
            kind="secret_ref"
            secretOnly
            disabled={disabled}
            required
            secrets={oauth2Secrets}
            currentSecret={currentFor(draft.clientSecretId)}
            secretsLoading={secretsLoading}
            secretsProblem={secretsProblem?.title ?? null}
            secretId={draft.clientSecretId}
            stored={draft.clientSecretConfiguredOnServer && draft.clientSecretId !== null && !draft.clientSecretReplacing
              ? { kind: 'secret_ref' }
              : null}
            replacing={draft.clientSecretReplacing}
            onRequestReplace={() => update((current) => ({ ...current, clientSecretReplacing: true }))}
            onClear={() => update((current) => ({
              ...current,
              clientSecretId: null,
              clientSecretConfiguredOnServer: false,
              clientSecretReplacing: false,
            }))}
            onSecretChange={(secretId) => update((current) => ({
              ...current,
              clientSecretId: secretId,
              clientSecretReplacing: true,
            }))}
            literalValue=""
            onLiteralChange={() => undefined}
            onKindChange={() => undefined}
            description="A managed secret reference; the value stays server-side and is never displayed."
            emptyHint={`No active secrets with purpose ${CALLBACK_SECRET_PURPOSES.oauth2ClientSecret} — create one in the Secrets tab first.`}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-semibold text-[var(--text-main)]">
              Provider extensions (optional, max {CALLBACK_MAX_OAUTH2_EXTENSIONS})
            </legend>
            {draft.extensions.map((extension, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <FormField id={`${idPrefix}-extension-name-${index}`} label="Name" className="max-w-[12rem]">
                  <Input
                    id={`${idPrefix}-extension-name-${index}`}
                    value={extension.name}
                    placeholder="audience_type"
                    disabled={disabled}
                    onChange={(event) => update((current) => ({
                      ...current,
                      extensions: current.extensions.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, name: event.target.value } : item),
                    }))}
                  />
                </FormField>
                <FormField id={`${idPrefix}-extension-value-${index}`} label="Value" className="flex-1 min-w-[12rem]">
                  <Input
                    id={`${idPrefix}-extension-value-${index}`}
                    value={extension.value}
                    disabled={disabled}
                    onChange={(event) => update((current) => ({
                      ...current,
                      extensions: current.extensions.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, value: event.target.value } : item),
                    }))}
                  />
                </FormField>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => update((current) => ({
                    ...current,
                    extensions: current.extensions.filter((_item, itemIndex) => itemIndex !== index),
                  }))}
                >
                  Remove
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || draft.extensions.length >= CALLBACK_MAX_OAUTH2_EXTENSIONS}
                onClick={() => update((current) => ({
                  ...current,
                  extensions: [...current.extensions, { name: '', value: '' }],
                }))}
              >
                Add extension
              </Button>
            </div>
          </fieldset>
        </fieldset>
      ) : null}

      {draft.authMethod !== 'none' ? (
        <fieldset className="flex flex-col gap-3" disabled={disabled}>
          <legend className="text-xs font-semibold text-[var(--text-main)]">Approved destinations</legend>
          <p className="text-xs text-[var(--text-sub)]">
            Credentials are attached only when the caller&apos;s callback URL matches an exact approved origin
            (and path prefix when set). One entry per line.
          </p>
          <FormField id={`${idPrefix}-approved-origins`} label="Approved https origins" required>
            <textarea
              id={`${idPrefix}-approved-origins`}
              className="min-h-[5rem] w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] p-2 font-mono text-xs text-[var(--text-main)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              value={draft.approvedOrigins}
              disabled={disabled}
              placeholder={'https://receiver.example\nhttps://partner.example:8443'}
              onChange={(event) => update((current) => ({ ...current, approvedOrigins: event.target.value }))}
            />
          </FormField>
          <FormField id={`${idPrefix}-path-prefixes`} label="Allowed path prefixes (optional)">
            <textarea
              id={`${idPrefix}-path-prefixes`}
              className="min-h-[4rem] w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] p-2 font-mono text-xs text-[var(--text-main)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              value={draft.allowedPathPrefixes}
              disabled={disabled}
              placeholder="/webhooks"
              onChange={(event) => update((current) => ({ ...current, allowedPathPrefixes: event.target.value }))}
            />
          </FormField>
        </fieldset>
      ) : null}

      {validation.length > 0 ? (
        <AlertBanner variant="warning" title="Callback policy is not ready">
          <ul className="list-disc pl-4">
            {validation.map((message) => <li key={message}>{message}</li>)}
          </ul>
        </AlertBanner>
      ) : (
        <p className="flex items-center gap-2 text-xs text-[var(--text-sub)]">
          <Badge variant="success" dot>valid on client</Badge>
          The server re-validates every rule; this is a preview, not an approval.
        </p>
      )}
    </div>
  );
}

export { buildCallbackPolicy, emptyCallbackDraft };
