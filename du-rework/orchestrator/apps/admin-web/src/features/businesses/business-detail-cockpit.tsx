import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/state-panel';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  createAdminApiClient,
  type AdminApiProblem,
  type BusinessVersions,
  type ProfileListPage,
  type ProfileListRow,
  type ProfileWorkflowPage,
  type WorkerInstanceList,
} from '@/lib/api';
import { useTenant } from '@/lib/tenant-context';
import { parseBusinessVersions } from './state';
import { newest } from './cockpit-sample-time';

/**
 * Per-block state. `unavailable` is a FIRST CLASS variant so a card can admit
 * it has no read to perform instead of rendering an empty table that reads as
 * an established fact.
 */
type Block<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T }
  | { kind: 'failed'; problem: AdminApiProblem }
  | { kind: 'unavailable'; reason: string };

interface Props {
  businessId: string;
}


function SampleTime({ at }: { at: string | null }): React.JSX.Element {
  return (
    <span className="text-xs text-[var(--text-sub)]">
      {at === null ? 'no sample time reported by this read' : 'sampled ' + at}
    </span>
  );
}

function CardError({ problem, onRetry }: { problem: AdminApiProblem; onRetry: () => void }): React.JSX.Element {
  return (
    <ErrorState
      title={problem.title ?? 'This read failed.'}
      statusCode={problem.status}
      error={problem.code}
      onRetry={onRetry}
    />
  );
}

export function BusinessDetailCockpit({ businessId }: Props) {
  const { tenantId } = useTenant();
  const client = useMemo(() => createAdminApiClient(), []);
  const [versions, setVersions] = useState<Block<BusinessVersions>>({ kind: 'loading' });
  const [workers, setWorkers] = useState<Block<WorkerInstanceList>>({ kind: 'loading' });
  const [profiles, setProfiles] = useState<Block<ProfileListPage>>({ kind: 'loading' });
  const [workflows, setWorkflows] = useState<Block<ProfileWorkflowPage>>({ kind: 'loading' });
  const [workflowProfile, setWorkflowProfile] = useState<string>('');

  // Each card loads on its own: one failing endpoint must not blank the other
  // three answers (BIZ-04 rule 7).
  const loadVersions = useCallback(async (): Promise<void> => {
    setVersions({ kind: 'loading' });
    const result = await client.getBusinessVersions(businessId);
    if (!result.ok) { setVersions({ kind: 'failed', problem: result.problem }); return; }
    const parsed = parseBusinessVersions(result.data);
    setVersions(
      parsed === null
        ? { kind: 'failed', problem: { status: 502, code: 'UNREADABLE_RESPONSE', title: 'Unreadable versions payload.' } }
        : { kind: 'ready', data: parsed },
    );
  }, [businessId, client]);

  const loadWorkers = useCallback(async (): Promise<void> => {
    setWorkers({ kind: 'loading' });
    const result = await client.listWorkerInstances({ businessId });
    if (!result.ok) { setWorkers({ kind: 'failed', problem: result.problem }); return; }
    setWorkers({ kind: 'ready', data: result.data });
  }, [businessId, client]);

  const loadProfiles = useCallback(async (): Promise<void> => {
    setProfiles({ kind: 'loading' });
    const result = await client.listProfiles({ businessId, limit: '100' });
    if (!result.ok) { setProfiles({ kind: 'failed', problem: result.problem }); return; }
    setProfiles({ kind: 'ready', data: result.data });
  }, [businessId, client]);

  useEffect(() => {
    void loadVersions();
    void loadWorkers();
    void loadProfiles();
  }, [loadProfiles, loadVersions, loadWorkers]);

  // Workflow bindings are PROFILE addressed (BIZ-07), so this card resolves a
  // profile first. With no profile there is nothing to resolve against, which
  // is an explicit state rather than an empty table.
  const profileRows: ProfileListRow[] = profiles.kind === 'ready' ? profiles.data.items : [];
  useEffect(() => {
    if (workflowProfile.length === 0 && profileRows.length > 0) setWorkflowProfile(profileRows[0]!.profileName);
  }, [profileRows, workflowProfile]);

  const loadWorkflows = useCallback(async (): Promise<void> => {
    if (workflowProfile.length === 0) {
      setWorkflows({ kind: 'unavailable', reason: 'pick a profile to resolve workflow bindings against' });
      return;
    }
    if (tenantId === null) {
      setWorkflows({ kind: 'unavailable', reason: 'no active tenant, so the read cannot be scoped' });
      return;
    }
    setWorkflows({ kind: 'loading' });
    const result = await client.listProfileWorkflows(businessId, 'latest', workflowProfile, tenantId);
    if (!result.ok) { setWorkflows({ kind: 'failed', problem: result.problem }); return; }
    setWorkflows({ kind: 'ready', data: result.data });
  }, [businessId, client, tenantId, workflowProfile]);

  useEffect(() => { void loadWorkflows(); }, [loadWorkflows]);

  return (
    <section aria-labelledby="business-cockpit-title" className="flex flex-col gap-4 min-w-0">
      <h2 id="business-cockpit-title" className="text-sm font-semibold">
        Detail for {businessId}
      </h2>

      <Card>
        <CardHeader>
          <CardTitle>Business versions and worker replicas</CardTitle>
          <CardDescription>
            Worker state is grouped under its registered business version. Accepted tasks counts successful claims across versions for the same worker instance; the counter-since time identifies its measurement epoch. The default version only selects the target for new submissions.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {versions.kind === 'loading' ? <LoadingState title="Loading versions" /> : null}
          {versions.kind === 'failed' ? <CardError problem={versions.problem} onRetry={() => void loadVersions()} /> : null}
          {versions.kind === 'ready' ? <SampleTime at={newest(versions.data.rows)} /> : null}
          {workers.kind === 'loading' ? <LoadingState title="Loading worker replicas" /> : null}
          {workers.kind === 'failed' ? <CardError problem={workers.problem} onRetry={() => void loadWorkers()} /> : null}
          {workers.kind === 'ready' ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-sub)]">
              <SampleTime at={workers.data.sampledAt} />
              {workers.data.truncated ? <Badge variant="warning" dot>inventory truncated by the server</Badge> : null}
              <span>Queue backlog is version-scoped and is not reported by this worker inventory.</span>
            </div>
          ) : null}
          {versions.kind === 'ready' && versions.data.rows.length === 0 ? (
            <p className="text-sm text-[var(--text-sub)]">No version rows registered for this business.</p>
          ) : null}
          {versions.kind === 'ready' && versions.data.rows.length > 0 ? (
            <div className="flex flex-col gap-4">
              {versions.data.rows.map((version) => {
                const replicas = workers.kind === 'ready'
                  ? workers.data.items.filter((worker) => worker.businessVersion === version.version)
                  : [];
                return (
                  <section key={version.version} aria-labelledby={`business-version-${version.version}`} className="rounded border border-[var(--border-subtle)] p-3">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <h3 id={`business-version-${version.version}`} className="font-mono text-sm font-semibold">{version.version}</h3>
                      <Badge variant={version.status === 'ENABLED' ? 'success' : version.status === 'DRAINING' ? 'warning' : 'neutral'} dot>{version.status}</Badge>
                      <Badge variant={version.isActive ? 'success' : 'neutral'}>{version.isActive ? 'Default for new submissions' : 'Not default'}</Badge>
                      <span className="ml-auto text-xs text-[var(--text-sub)]">updated {version.updatedAt ?? 'not reported'}</span>
                    </div>
                    {workers.kind === 'ready' && replicas.length === 0 ? (
                      <p className="text-sm text-[var(--text-sub)]">No worker instances are currently reported for this version.</p>
                    ) : null}
                    {workers.kind === 'ready' && replicas.length > 0 ? (
                      <TableContainer>
                        <Table aria-label={`Worker replicas for ${businessId} version ${version.version}`}>
                          <TableHeader><TableRow>
                            <TableHead>Instance</TableHead><TableHead>State</TableHead><TableHead>Health</TableHead><TableHead>Accepted tasks</TableHead><TableHead>Running / capacity</TableHead><TableHead>Last seen</TableHead><TableHead>Observed</TableHead>
                          </TableRow></TableHeader>
                          <TableBody>{replicas.map((worker) => (
                            <TableRow key={worker.instanceId}>
                              <TableCell className="font-mono text-xs">{worker.instanceId}</TableCell>
                              <TableCell><Badge variant={worker.state === 'ONLINE' ? 'success' : worker.state === 'DRAINING' ? 'warning' : 'neutral'} dot>{worker.state}</Badge></TableCell>
                              <TableCell><Badge variant={worker.health === 'HEALTHY' ? 'success' : worker.health === 'DEGRADED' ? 'warning' : 'neutral'} dot>{worker.health}</Badge></TableCell>
              <TableCell title={`Scope: ${worker.acceptedTaskCountScope ?? 'not reported'}. Counter since: ${worker.acceptedTaskCountSince ?? 'not reported'}. A new instance identity starts a new counter.`}>
                                {typeof worker.acceptedTaskCount === 'number' ? worker.acceptedTaskCount.toLocaleString() : 'Not reported'}
                              </TableCell>
                              <TableCell>{worker.activeLeases} / {worker.capacity}</TableCell>
                              <TableCell className="text-xs">{worker.lastSeenAt}</TableCell>
                              <TableCell className="text-xs">{worker.observedAt}</TableCell>
                            </TableRow>
                          ))}</TableBody>
                        </Table>
                      </TableContainer>
                    ) : null}
                  </section>
                );
              })}
              {workers.kind === 'ready' && workers.data.items.some((worker) => !versions.data.rows.some((version) => version.version === worker.businessVersion)) ? (
                <section aria-labelledby="unmatched-worker-version" className="rounded border border-[var(--border-subtle)] p-3">
                  <h3 id="unmatched-worker-version" className="mb-2 text-sm font-semibold">Worker rows without a registered version row</h3>
                  <p className="mb-3 text-xs text-[var(--text-sub)]">These inventory rows are kept separate because their version is absent from the registry response.</p>
                  {workers.data.items.filter((worker) => !versions.data.rows.some((version) => version.version === worker.businessVersion)).map((worker) => (
                    <div key={worker.instanceId} className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] py-2 text-xs">
                      <span className="font-mono">{worker.businessVersion} · {worker.instanceId}</span><Badge variant={worker.state === 'ONLINE' ? 'success' : worker.state === 'DRAINING' ? 'warning' : 'neutral'}>{worker.state}</Badge>
                      <span>{typeof worker.acceptedTaskCount === 'number' ? `${worker.acceptedTaskCount} accepted` : 'accepted count not reported'}</span><span>{worker.activeLeases}/{worker.capacity} running/capacity</span>
                    </div>
                  ))}
                </section>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profiles</CardTitle>
          <CardDescription>Profiles registered for this business, with the memberships recorded on each.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {profiles.kind === 'loading' ? <LoadingState title="Loading profiles" /> : null}
          {profiles.kind === 'failed' ? <CardError problem={profiles.problem} onRetry={() => void loadProfiles()} /> : null}
          {profiles.kind === 'ready' ? <SampleTime at={newest(profiles.data.items)} /> : null}
          {profiles.kind === 'ready' && profiles.data.items.length === 0 ? (
            <p className="text-sm text-[var(--text-sub)]">No profile rows for this business.</p>
          ) : null}
          {profiles.kind === 'ready' && profiles.data.items.length > 0 ? (
            <TableContainer>
              <Table aria-label="Profiles of this business">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead><TableHead>Version</TableHead><TableHead>Revision</TableHead><TableHead>Status</TableHead><TableHead>Keys</TableHead><TableHead>Actions</TableHead><TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {profiles.data.items.map((row) => (
                    <TableRow key={row.profileName + ' ' + row.businessVersion}>
                      <TableCell>{row.profileName}</TableCell>
                      <TableCell className="font-mono">{row.businessVersion}</TableCell>
                      <TableCell>{row.revision === 0 ? 'unsaved' : row.revision}</TableCell>
                      <TableCell><Badge variant={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status}</Badge></TableCell>
                      <TableCell>{row.keyCount}</TableCell>
                      <TableCell className="text-xs">{row.boundActions.join(', ') || 'none recorded'}</TableCell>
                      <TableCell className="text-xs">{row.updatedAt ?? 'not reported'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workflow schema bindings</CardTitle>
          <CardDescription>
            Workflow revisions this profile business owns, with the binding state per revision.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {profileRows.length > 0 ? (
            <select
              aria-label="Profile for workflow bindings"
              className="h-9 rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-xs"
              value={workflowProfile}
              onChange={(e) => setWorkflowProfile(e.target.value)}
            >
              {profileRows.map((row) => (
                <option key={row.profileName} value={row.profileName}>{row.profileName}</option>
              ))}
            </select>
          ) : null}
          {workflows.kind === 'loading' ? <LoadingState title="Loading workflow bindings" /> : null}
          {workflows.kind === 'unavailable' ? (
            <p className="text-sm text-[var(--text-sub)]">{workflows.reason}</p>
          ) : null}
          {workflows.kind === 'failed' ? <CardError problem={workflows.problem} onRetry={() => void loadWorkflows()} /> : null}
          {workflows.kind === 'ready' ? <SampleTime at={newest(workflows.data.items)} /> : null}
          {workflows.kind === 'ready' && workflows.data.items.length === 0 ? (
            <p className="text-sm text-[var(--text-sub)]">No workflow rows address this business and version.</p>
          ) : null}
          {workflows.kind === 'ready' && workflows.data.items.length > 0 ? (
            <TableContainer>
              <Table aria-label="Workflow schema bindings">
                <TableHeader>
                  <TableRow>
                    <TableHead>Slug</TableHead><TableHead>Revision</TableHead><TableHead>Status</TableHead><TableHead>Bound to profile</TableHead><TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workflows.data.items.map((row) => (
                    <TableRow key={row.slug + ' ' + String(row.revision)}>
                      <TableCell className="font-mono">{row.slug}</TableCell>
                      <TableCell>{row.revision}</TableCell>
                      <TableCell><Badge variant={row.status === 'active' ? 'success' : 'neutral'}>{row.status}</Badge></TableCell>
                      <TableCell>{row.enabled ? 'enabled' : 'not bound'}</TableCell>
                      <TableCell className="text-xs">{row.createdAt}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
