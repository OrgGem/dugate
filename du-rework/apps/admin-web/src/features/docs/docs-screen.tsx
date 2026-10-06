import { useEffect, useMemo, useState } from 'react';
import { AlertBanner, LoadingState } from '@/components/ui/state-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { createAdminApiClient, type AdminApiProblem, type AdminWebSession } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/dialog';
import { BusinessInputs } from '@/features/businesses/business-inputs';

interface EndpointMethod {
  name: string;
  path: string;
  method: string;
}

/**
 * Session gate — the client only learns its server-issued CSRF proof from
 * `getSession()` (see lib/api/client.ts), so a mutation attempted before that
 * read goes out with no `x-csrf-token` and the BFF answers 403 CSRF_REJECTED.
 * The same bootstrap order the UI_APPROVED identity screen uses.
 */
type SessionState =
  | { kind: 'loading' }
  | { kind: 'ready'; session: AdminWebSession }
  | { kind: 'failed'; problem: AdminApiProblem };

/**
 * API Docs + Test Workbench — CFGADM-11. Builds a minimal endpoint catalog
 * from the client surface (real routes that exist in the browser client). The
 * Test Endpoint workbench uses the existing testProfileEndpoint client.
 */
export function DocsScreen() {
  const client = useMemo(() => createAdminApiClient(), []);
  const [sessionState, setSessionState] = useState<SessionState>({ kind: 'loading' });
  const [testOpen, setTestOpen] = useState(false);
  const [businessId, setBusinessId] = useState('');
  const [businessVersion, setBusinessVersion] = useState('1.0');
  const [profileName, setProfileName] = useState('');
  const [endpointSlug, setEndpointSlug] = useState('');
  const [testFileUrls, setTestFileUrls] = useState('');
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [testProblem, setTestProblem] = useState<AdminApiProblem | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const session = await client.getSession();
      if (!active) return;
      setSessionState(session.ok ? { kind: 'ready', session: session.data } : { kind: 'failed', problem: session.problem });
    })();
    return () => {
      active = false;
    };
  }, [client]);

  // Fail-closed: the workbench POST is a write, so it needs both a proven
  // session (the CSRF proof source) and a role allowed to drive a profile test.
  const sessionRole = sessionState.kind === 'ready' ? sessionState.session.role : null;
  const canRunTest = sessionRole === 'admin' || sessionRole === 'operator';
  const testUnavailableReason =
    sessionState.kind === 'loading'
      ? 'Reading the admin session before enabling writes (the CSRF proof is issued by that read).'
      : sessionState.kind === 'failed'
        ? 'Admin session unavailable, so the server-issued CSRF proof cannot be obtained; every write stays disabled (fail-closed).'
        : !canRunTest
          ? `Profile Test Endpoint requires an admin or operator session (this session is ${sessionRole}); writes stay disabled.`
          : '';

  // Minimal but honest catalog (derived from the client surface in the same bundle).
  const endpoints = useMemo<EndpointMethod[]>(
    () => [
      { name: 'Session', path: '/session', method: 'GET' },
      { name: 'Audit', path: '/audit', method: 'GET' },
      { name: 'Api Keys (list)', path: '/api-keys', method: 'GET' },
      { name: 'Connectors list/capabilities', path: '/connectors', method: 'GET' },
      { name: 'Connector revision', path: '/connectors/:id/revisions/:rev', method: 'GET' },
      { name: 'Profiles detail', path: '/profiles/:b/:v/:name', method: 'GET' },
      { name: 'Profile mutations', path: '/profiles/.../upsert|publish|rollback', method: 'POST' },
      { name: 'Profile Test Endpoint', path: '/profiles/test-endpoint', method: 'POST' },
      { name: 'Operations list/detail/result', path: '/operations', method: 'GET' },
      { name: 'Usage', path: '/usage', method: 'GET' },
      { name: 'Businesses/versions', path: '/businesses', method: 'GET' },
      { name: 'Crypto config', path: '/crypto-config', method: 'GET/POST' },
      { name: 'Actions', path: '/actions', method: 'POST' },
    ],
    [],
  );

  async function runTestEndpoint(): Promise<void> {
    // Fail-closed guard: without a proven session the client holds no CSRF
    // proof, so the POST would be rejected 403 CSRF_REJECTED. Refuse before
    // spending a round trip, and never render a half-truth as a result.
    if (sessionState.kind !== 'ready' || !canRunTest) {
      setTestResult(null);
      setTestProblem({
        status: sessionState.kind === 'failed' ? sessionState.problem.status : 403,
        code: sessionState.kind === 'failed' ? sessionState.problem.code ?? 'SESSION_ERROR' : 'FORBIDDEN',
        title: 'Profile Test Endpoint is unavailable for this session',
      });
      return;
    }
    if (!businessId || !businessVersion || !profileName || !endpointSlug) {
      setTestProblem({
        status: 422,
        code: 'INVALID_SCHEMA',
        title: 'Please fill businessId, businessVersion, profileName, endpointSlug',
      });
      return;
    }
    setBusy(true);
    setTestResult(null);
    setTestProblem(null);
    try {
      const result = await client.testProfileEndpoint(
        {
          businessId,
          businessVersion,
          profileName,
          endpointSlug,
          parameters: {},
          file_urls: testFileUrls
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        },
        crypto.randomUUID(),
      );
      if (result.ok) setTestResult(result.data);
      else setTestProblem(result.problem);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>API Docs + Test Workbench</CardTitle>
          <CardDescription>
            Endpoint catalog derived from the browser client surface. Test Endpoint dispatches
            the real BFF route when available.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Endpoints</h3>
              <Badge variant="info">same-origin /admin/api</Badge>
            </div>
            <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--radius-sm)] border border-[var(--border-subtle)]">
              {endpoints.map((ep) => (
                <li key={ep.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{ep.name}</span>
                    <code className="truncate text-xs text-muted-foreground">{ep.path}</code>
                  </div>
                  <Badge variant="neutral" className="shrink-0">
                    {ep.method}
                  </Badge>
                </li>
              ))}
            </ul>
            {sessionState.kind === 'loading' ? (
              <LoadingState
                title="Reading the admin session"
                description="The Test Workbench stays disabled until the server issues its CSRF proof."
              />
            ) : null}
            {testUnavailableReason !== '' ? (
              <AlertBanner
                variant={sessionState.kind === 'failed' ? 'error' : 'warning'}
                title={sessionState.kind === 'failed' ? 'Admin session unavailable' : 'Test Workbench disabled'}
              >
                {testUnavailableReason}
              </AlertBanner>
            ) : null}
          </div>

          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setTestOpen(true)}>
              Open Test Workbench
            </Button>
          </div>
        </CardContent>
      </Card>

      <Modal
        open={testOpen}
        onOpenChange={setTestOpen}
        title="Test Workbench (CFGADM-11)"
        description="Profile Test Endpoint via POST /admin/api/profiles/test-endpoint (same-origin)."
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setTestOpen(false)}>
              Close
            </Button>
            <Button onClick={() => void runTestEndpoint()} disabled={busy || !canRunTest}>
              {busy ? 'Running...' : 'Run test'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {testUnavailableReason !== '' ? (
            <AlertBanner
              variant={sessionState.kind === 'failed' ? 'error' : 'warning'}
              title={sessionState.kind === 'failed' ? 'Admin session unavailable' : 'Test Workbench disabled'}
            >
              {testUnavailableReason}
            </AlertBanner>
          ) : null}
          {testOpen ? <BusinessInputs businessId={businessId} businessVersion={businessVersion} onBusinessChange={setBusinessId} onVersionChange={setBusinessVersion} /> : null}
          <Input
            aria-label="profileName"
            placeholder="profileName"
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
          />
          <Input
            aria-label="endpointSlug"
            placeholder="endpointSlug"
            value={endpointSlug}
            onChange={(e) => setEndpointSlug(e.target.value)}
          />
          <textarea
            aria-label="file urls"
            className="min-h-20 w-full rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3 text-sm"
            placeholder="file_urls (one per line)"
            value={testFileUrls}
            onChange={(e) => setTestFileUrls(e.target.value)}
          />
          {testProblem !== null ? (
            <AlertBanner variant="error" title={testProblem.title ?? 'Test failed'}>
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
    </div>
  );
}
