import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertBanner, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TablePagination, TableRow } from '@/components/ui/table';
import { TabsList, TabsPanel, TabsRoot, TabsTab } from '@/components/ui/tabs';
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
  const profileCatalogScopeKey = JSON.stringify([businessId, tenantId]);
  const client = useMemo(() => createAdminApiClient(), []);
  const [versions, setVersions] = useState<Block<BusinessVersions>>({ kind: 'loading' });
  const [workers, setWorkers] = useState<Block<WorkerInstanceList>>({ kind: 'loading' });
  const [profiles, setProfiles] = useState<Block<ProfileListPage>>({ kind: 'loading' });
  const [workflows, setWorkflows] = useState<Block<ProfileWorkflowPage>>({ kind: 'loading' });
  const [workflowProfile, setWorkflowProfile] = useState<string>('');
  const [workflowProfileScope, setWorkflowProfileScope] = useState(profileCatalogScopeKey);
  const [versionIndex, setVersionIndex] = useState(0);
  const [workerIndex, setWorkerIndex] = useState(0);
  const [workflowIndex, setWorkflowIndex] = useState(0);
  const [profileIndex, setProfileIndex] = useState(0);
  const [profileCursors, setProfileCursors] = useState<Array<string | undefined>>([undefined]);
  const [profilePaging, setProfilePaging] = useState(false);
  const [failedProfilePage, setFailedProfilePage] = useState<{ index: number; cursor?: string } | null>(null);
  const profileRequestGeneration = useRef(0);
  const profilePagingRef = useRef(false);
  const profileCatalogScopeRef = useRef(profileCatalogScopeKey);
  const workflowRequestGeneration = useRef(0);

  useLayoutEffect(() => {
    if (profileCatalogScopeRef.current === profileCatalogScopeKey) return;
    profileCatalogScopeRef.current = profileCatalogScopeKey;
    profileRequestGeneration.current += 1;
    profilePagingRef.current = false;
    setProfiles({ kind: 'loading' });
    setWorkflowProfile('');
    setWorkflowProfileScope(profileCatalogScopeKey);
    setProfileIndex(0);
    setProfileCursors([undefined]);
    setFailedProfilePage(null);
    setProfilePaging(false);
  }, [profileCatalogScopeKey]);

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

  const loadProfiles = useCallback(async (cursor?: string, requestedIndex = 0): Promise<boolean> => {
    const generation = ++profileRequestGeneration.current;
    const requestScope = profileCatalogScopeRef.current;
    const isCurrent = (): boolean => generation === profileRequestGeneration.current
      && profileCatalogScopeRef.current === requestScope;
    setProfiles({ kind: 'loading' });
    try {
      const result = await client.listProfiles({ businessId, limit: '50', ...(tenantId ? { tenantId } : {}), ...(cursor ? { cursor } : {}) });
      if (!isCurrent()) return false;
      if (!result.ok) {
        setProfiles({ kind: 'failed', problem: result.problem });
        setFailedProfilePage({ index: requestedIndex, ...(cursor === undefined ? {} : { cursor }) });
        return false;
      }
      setProfiles({ kind: 'ready', data: result.data });
      setFailedProfilePage(null);
      return true;
    } catch {
      if (isCurrent()) {
        setProfiles({ kind: 'failed', problem: { status: 0, code: 'NETWORK_ERROR', title: 'The business profile page could not be loaded.' } });
        setFailedProfilePage({ index: requestedIndex, ...(cursor === undefined ? {} : { cursor }) });
      }
      return false;
    }
  }, [businessId, client, tenantId]);

  async function loadProfilePage(index: number, cursor: string | undefined): Promise<void> {
    if (profilePagingRef.current || index < 0) return;
    profilePagingRef.current = true;
    setProfilePaging(true);
    const generation = profileRequestGeneration.current + 1;
    try {
      const loaded = await loadProfiles(cursor, index);
      if (generation !== profileRequestGeneration.current) return;
      if (loaded) {
        setProfileIndex(index);
        if (index > profileIndex) setProfileCursors((history) => [...history.slice(0, index), cursor]);
      }
    } finally {
      if (generation === profileRequestGeneration.current) {
        profilePagingRef.current = false;
        setProfilePaging(false);
      }
    }
  }

  function nextProfiles(): void {
    if (profiles.kind !== 'ready' || profiles.data.nextCursor === null || profilePaging) return;
    const nextIndex = profileIndex + 1;
    void loadProfilePage(nextIndex, profiles.data.nextCursor);
  }

  useEffect(() => {
    setVersionIndex(0);
    setWorkerIndex(0);
    setWorkflowIndex(0);
    setProfileIndex(0);
    setProfileCursors([undefined]);
    setFailedProfilePage(null);
    profilePagingRef.current = false;
    setProfilePaging(false);
    void loadVersions();
    void loadWorkers();
    void loadProfiles();
  }, [loadProfiles, loadVersions, loadWorkers]);

  // Workflow bindings are PROFILE addressed (BIZ-07), so this card resolves a
  // profile first. With no profile there is nothing to resolve against, which
  // is an explicit state rather than an empty table.
  const profileRows: ProfileListRow[] = profiles.kind === 'ready' ? profiles.data.items : [];
  useEffect(() => {
    if (workflowProfileScope === profileCatalogScopeKey && workflowProfile.length === 0 && profileRows.length > 0) {
      setWorkflowProfile(profileRows[0]!.profileName);
    }
  }, [profileCatalogScopeKey, profileRows, workflowProfile, workflowProfileScope]);
  const selectedWorkflowProfile = workflowProfileScope === profileCatalogScopeKey ? workflowProfile : '';
  const workflowProfileOnCurrentPage = profileRows.some((row) => row.profileName === workflowProfile);

  const loadWorkflows = useCallback(async (): Promise<void> => {
    const generation = ++workflowRequestGeneration.current;
    const isCurrent = (): boolean => generation === workflowRequestGeneration.current;
    if (workflowProfileScope !== profileCatalogScopeKey) {
      setWorkflows({ kind: 'unavailable', reason: 'loading the selected business and tenant profile scope' });
      return;
    }
    if (selectedWorkflowProfile.length === 0) {
      setWorkflows({ kind: 'unavailable', reason: 'pick a profile to resolve workflow bindings against' });
      return;
    }
    if (tenantId === null) {
      setWorkflows({ kind: 'unavailable', reason: 'no active tenant, so the read cannot be scoped' });
      return;
    }
    setWorkflows({ kind: 'loading' });
    try {
      const result = await client.listProfileWorkflows(businessId, 'latest', selectedWorkflowProfile, tenantId);
      if (!isCurrent()) return;
      if (!result.ok) { setWorkflows({ kind: 'failed', problem: result.problem }); return; }
      setWorkflows({ kind: 'ready', data: result.data });
    } catch {
      if (isCurrent()) setWorkflows({ kind: 'failed', problem: { status: 0, code: 'NETWORK_ERROR', title: 'Workflow bindings could not be loaded.' } });
    }
  }, [businessId, client, profileCatalogScopeKey, selectedWorkflowProfile, tenantId, workflowProfileScope]);

  useEffect(() => {
    void loadWorkflows();
    return () => { workflowRequestGeneration.current += 1; };
  }, [loadWorkflows]);

  const loadedVersions = versions.kind === 'ready' ? versions.data.rows : [];
  const visibleVersions = loadedVersions.slice(versionIndex * 20, versionIndex * 20 + 20);
  const loadedWorkers = workers.kind === 'ready' ? workers.data.items : [];
  const workerGroups = versions.kind === 'ready'
    ? versions.data.rows.map((version) => ({ version, rows: loadedWorkers.filter((worker) => worker.businessVersion === version.version) }))
    : [];
  const unmatchedWorkers = versions.kind === 'ready'
    ? loadedWorkers.filter((worker) => !versions.data.rows.some((version) => version.version === worker.businessVersion))
    : loadedWorkers;
  const allWorkerGroups = unmatchedWorkers.length > 0
    ? [...workerGroups, { version: null, rows: unmatchedWorkers }]
    : workerGroups;
  const visibleWorkerGroups = allWorkerGroups.slice(workerIndex * 10, workerIndex * 10 + 10);
  const loadedWorkflows = workflows.kind === 'ready' ? workflows.data.items : [];
  const visibleWorkflows = loadedWorkflows.slice(workflowIndex * 20, workflowIndex * 20 + 20);

  return (
    <section aria-labelledby="business-cockpit-title" className="flex flex-col gap-3 min-w-0">
      <h2 id="business-cockpit-title" className="text-sm font-semibold">Detail for {businessId}</h2>
      <TabsRoot defaultValue="versions" className="min-w-0">
        <TabsList aria-label={`Business detail sections for ${businessId}`} className="flex-wrap">
          <TabsTab value="versions">Versions &amp; workers</TabsTab>
          <TabsTab value="profiles">Profiles</TabsTab>
          <TabsTab value="workflows">Workflow schemas</TabsTab>
        </TabsList>

        <TabsPanel value="versions" keepMounted className="pt-3">
          <Card>
            <CardHeader><CardTitle>Loaded business versions and workers</CardTitle><CardDescription>The version endpoint returns the current dataset. Version rows and their worker replicas stay grouped here; local paging covers only the rows returned by each read.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {versions.kind === 'loading' ? <LoadingState title="Loading versions" /> : null}
              {versions.kind === 'failed' ? <CardError problem={versions.problem} onRetry={() => void loadVersions()} /> : null}
              {versions.kind === 'ready' ? <>
                <SampleTime at={newest(versions.data.rows)} />
                {versions.data.submissionsPaused ? <AlertBanner variant="warning" title={`Submissions paused for pre-drain of ${versions.data.preDrainVersion ?? 'the active version'}`}>
                  {versions.data.remainingOperations === null || versions.data.remainingOperations === undefined
                    ? 'Remaining active operations are not reported. Refresh the version status before finalizing a cutover.'
                    : `${versions.data.remainingOperations.toLocaleString()} operation${versions.data.remainingOperations === 1 ? '' : 's'} remain on the pre-drain version.`}
                </AlertBanner> : null}
              </> : null}
              {versions.kind === 'ready' && loadedVersions.length === 0 ? <p className="text-sm text-[var(--text-sub)]">No version rows registered for this business.</p> : null}
              {versions.kind === 'ready' && loadedVersions.length > 0 ? <>
                <TableContainer maxHeight={360} aria-label="Loaded business version rows">
                  <Table aria-label="Business versions" density="compact">
                    <TableHeader sticky><TableRow><TableHead>Version</TableHead><TableHead>Version state</TableHead><TableHead>Business intake</TableHead><TableHead>Default pointer</TableHead><TableHead>Admission</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader>
                    <TableBody>{visibleVersions.map((version) => <TableRow key={version.version}>
                      <TableCell className="font-mono text-xs">{version.version}</TableCell>
                      <TableCell><Badge variant={version.status === 'ENABLED' ? 'success' : version.status === 'DRAINING' ? 'warning' : 'neutral'} dot>{version.status}</Badge></TableCell>
                      <TableCell><Badge variant={versions.kind === 'ready' && versions.data.enabled === true ? 'success' : versions.kind === 'ready' && versions.data.enabled === false ? 'neutral' : 'warning'}>{versions.kind === 'ready' && versions.data.enabled === true ? 'Enabled' : versions.kind === 'ready' && versions.data.enabled === false ? 'Disabled' : 'Unknown'}</Badge></TableCell>
                      <TableCell>{version.isActive ? 'Default for new submissions' : 'Not default'}</TableCell>
                      <TableCell><Badge variant={version.admissionEligible === true ? 'success' : version.admissionEligible === false ? 'warning' : 'neutral'}>{version.admissionEligible === true ? 'Eligible' : version.admissionReason ?? 'Unknown'}</Badge></TableCell>
                      <TableCell className="text-xs">{version.updatedAt ?? 'not reported'}</TableCell>
                    </TableRow>)}</TableBody>
                  </Table>
                </TableContainer>
                <TablePagination ariaLabel="Loaded business version pages" hasPreviousPage={versionIndex > 0} hasNextPage={(versionIndex + 1) * 20 < loadedVersions.length} onPreviousPage={() => setVersionIndex((index) => Math.max(0, index - 1))} onNextPage={() => setVersionIndex((index) => index + 1)} status={`Page ${versionIndex + 1} · ${loadedVersions.length} loaded version rows`} className="justify-end" />
              </> : null}
              {workers.kind === 'loading' ? <LoadingState title="Loading worker replicas" /> : null}
              {workers.kind === 'failed' ? <CardError problem={workers.problem} onRetry={() => void loadWorkers()} /> : null}
              {workers.kind === 'ready' ? <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-sub)]"><SampleTime at={workers.data.sampledAt} /><span>{workers.data.items.length.toLocaleString()} of {workers.data.total.toLocaleString()} worker instances loaded</span>{workers.data.truncated ? <Badge variant="warning" dot>inventory truncated by the server</Badge> : null}<span>Accepted task counts are since the counter-since time; a new worker identity starts a new counter.</span></div> : null}
              {workers.kind === 'ready' && loadedWorkers.length === 0 ? <p className="text-sm text-[var(--text-sub)]">No worker instances are currently reported for this business.</p> : null}
              {workers.kind === 'ready' && loadedWorkers.length > 0 ? <>
                <div className="flex flex-col gap-3">
                  <h3 className="text-sm font-semibold">Workers grouped by business version</h3>
                  {visibleWorkerGroups.map((group) => <section key={group.version?.version ?? 'unmatched-workers'} className="min-w-0 rounded-md border border-[var(--border-subtle)] p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <h4 className="font-mono text-sm font-semibold">{group.version?.version ?? (versions.kind === 'ready' ? 'Version absent from loaded registry' : 'Version registry unavailable')}</h4>
                      {group.version ? <>
                        <Badge variant={group.version.status === 'ENABLED' ? 'success' : group.version.status === 'DRAINING' ? 'warning' : 'neutral'} dot>{group.version.status}</Badge>
                        <Badge variant={versions.kind === 'ready' && versions.data.enabled === true ? 'success' : versions.kind === 'ready' && versions.data.enabled === false ? 'neutral' : 'warning'}>Intake {versions.kind === 'ready' && versions.data.enabled === true ? 'enabled' : versions.kind === 'ready' && versions.data.enabled === false ? 'disabled' : 'unknown'}</Badge>
                      </> : <Badge variant="warning">Unmatched inventory</Badge>}
                      <span className="text-xs text-[var(--text-sub)]">{group.rows.length} loaded worker{group.rows.length === 1 ? '' : 's'}</span>
                    </div>
                    {group.rows.length === 0 ? <p className="text-xs text-[var(--text-sub)]">No worker instances are currently reported for this version.</p> : <TableContainer maxHeight={260} aria-label={`Loaded workers for ${group.version?.version ?? 'unmatched version'}`}>
                      <Table aria-label={`Workers for ${group.version?.version ?? 'unmatched version'}`} density="compact">
                        <TableHeader sticky><TableRow><TableHead>Instance</TableHead><TableHead>State</TableHead><TableHead>Health</TableHead><TableHead>Accepted</TableHead><TableHead>Worker report</TableHead><TableHead>DB at heartbeat</TableHead><TableHead>Current DB leases / capacity</TableHead><TableHead>Last seen</TableHead><TableHead>Observed</TableHead></TableRow></TableHeader>
                        <TableBody>{group.rows.map((worker) => <TableRow key={worker.instanceId}>
                          <TableCell className="font-mono text-xs break-all">{worker.instanceId}</TableCell>
                          <TableCell><Badge variant={worker.state === 'ONLINE' ? 'success' : worker.state === 'DRAINING' ? 'warning' : 'neutral'} dot>{worker.state}</Badge></TableCell>
                          <TableCell><Badge variant={worker.health === 'HEALTHY' ? 'success' : worker.health === 'DEGRADED' ? 'warning' : 'neutral'} dot>{worker.health}</Badge></TableCell>
                          <TableCell title={`Scope: ${worker.acceptedTaskCountScope ?? 'not reported'}. Counter since: ${worker.acceptedTaskCountSince ?? 'not reported'}.`}>{typeof worker.acceptedTaskCount === 'number' ? worker.acceptedTaskCount.toLocaleString() : 'Not reported'}</TableCell>
                          <TableCell title={worker.reportedObservedAt ?? 'No worker self-report'}>{worker.reportedActiveTasks ?? 'Not reported'}</TableCell><TableCell>{worker.activeLeases}</TableCell><TableCell>{worker.durableLeases} / {worker.capacity}</TableCell><TableCell className="text-xs">{worker.lastSeenAt}</TableCell><TableCell className="text-xs">{worker.observedAt}</TableCell>
                        </TableRow>)}</TableBody>
                      </Table>
                    </TableContainer>}
                  </section>)}
                  {allWorkerGroups.length > 0 ? <TablePagination ariaLabel="Loaded version worker groups" hasPreviousPage={workerIndex > 0} hasNextPage={(workerIndex + 1) * 10 < allWorkerGroups.length} onPreviousPage={() => setWorkerIndex((index) => Math.max(0, index - 1))} onNextPage={() => setWorkerIndex((index) => index + 1)} status={`Group page ${workerIndex + 1} · ${allWorkerGroups.length} loaded version groups${workers.kind === 'ready' && workers.data.truncated ? ' · server inventory truncated' : ''}`} className="justify-end" /> : null}
                </div>
              </> : null}
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="profiles" keepMounted className="pt-3">
          <Card>
            <CardHeader><CardTitle>Profiles</CardTitle><CardDescription>Profiles registered for this business, with the memberships recorded on each.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {profiles.kind === 'loading' ? <LoadingState title="Loading profiles" /> : null}
              {profiles.kind === 'failed' ? <CardError problem={profiles.problem} onRetry={() => { const retry = failedProfilePage ?? { index: profileIndex, cursor: profileCursors[profileIndex] }; void loadProfilePage(retry.index, retry.cursor); }} /> : null}
              {profiles.kind === 'ready' ? <><SampleTime at={newest(profiles.data.items)} /><p className="text-xs text-[var(--text-sub)]">Server page {profileIndex + 1} · {profiles.data.items.length} rows on this page of {profiles.data.total} reported. Use the server cursors to move through the result.</p></> : null}
              {profiles.kind === 'ready' && profiles.data.items.length === 0 ? <p className="text-sm text-[var(--text-sub)]">No profile rows for this business.</p> : null}
              {profiles.kind === 'ready' && profiles.data.items.length > 0 ? <>
                <TableContainer maxHeight={380} aria-label="Loaded business profiles">
                  <Table aria-label="Profiles of this business" density="compact">
                    <TableHeader sticky><TableRow><TableHead>Name</TableHead><TableHead>Version</TableHead><TableHead>Revision</TableHead><TableHead>Status</TableHead><TableHead>Keys</TableHead><TableHead>Actions</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader>
                    <TableBody>{profiles.data.items.map((row) => <TableRow key={row.profileName + ' ' + row.businessVersion}>
                      <TableCell>{row.profileName}</TableCell><TableCell className="font-mono">{row.businessVersion}</TableCell><TableCell>{row.revision === 0 ? 'unsaved' : row.revision}</TableCell><TableCell><Badge variant={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status}</Badge></TableCell><TableCell>{row.keyCount}</TableCell><TableCell className="text-xs">{row.boundActions.join(', ') || 'none recorded'}</TableCell><TableCell className="text-xs">{row.updatedAt ?? 'not reported'}</TableCell>
                    </TableRow>)}</TableBody>
                  </Table>
                </TableContainer>
                <TablePagination ariaLabel="Business profile server pages" hasPreviousPage={profiles.data.prevCursor !== null || profileIndex > 0} hasNextPage={profiles.data.nextCursor !== null} onPreviousPage={() => void loadProfilePage(profileIndex - 1, profiles.kind === 'ready' ? profiles.data.prevCursor ?? profileCursors[profileIndex - 1] : undefined)} onNextPage={nextProfiles} pending={profilePaging} status={`Server page ${profileIndex + 1} · ${profiles.data.total} total profiles reported`} className="justify-end" />
              </> : null}
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="workflows" keepMounted className="pt-3">
          <Card>
            <CardHeader><CardTitle>Workflow schema bindings</CardTitle><CardDescription>Workflow revisions this business owns, with the binding state per revision. These are the loaded rows for the selected profile.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {profileRows.length > 0 || selectedWorkflowProfile.length > 0 ? <select aria-label="Profile for workflow bindings" className="h-9 w-full max-w-sm rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-xs" value={selectedWorkflowProfile} onChange={(event) => { setWorkflowIndex(0); setWorkflowProfileScope(profileCatalogScopeKey); setWorkflowProfile(event.target.value); }}>{selectedWorkflowProfile.length > 0 && !workflowProfileOnCurrentPage ? <option value={selectedWorkflowProfile}>{selectedWorkflowProfile} (selected from another page)</option> : null}{profileRows.map((row) => <option key={row.profileName} value={row.profileName}>{row.profileName}</option>)}</select> : null}
              {workflows.kind === 'loading' ? <LoadingState title="Loading workflow bindings" /> : null}
              {workflows.kind === 'unavailable' ? <p className="text-sm text-[var(--text-sub)]">{workflows.reason}</p> : null}
              {workflows.kind === 'failed' ? <CardError problem={workflows.problem} onRetry={() => void loadWorkflows()} /> : null}
              {workflows.kind === 'ready' ? <><SampleTime at={newest(workflows.data.items)} /><p className="text-xs text-[var(--text-sub)]">{workflows.data.total} workflow rows loaded for this profile and business version.</p></> : null}
              {workflows.kind === 'ready' && workflows.data.items.length === 0 ? <p className="text-sm text-[var(--text-sub)]">No workflow rows address this business and version.</p> : null}
              {workflows.kind === 'ready' && workflows.data.items.length > 0 ? <>
                <TableContainer maxHeight={360} aria-label="Loaded workflow schemas">
                  <Table aria-label="Workflow schema bindings" density="compact">
                    <TableHeader sticky><TableRow><TableHead>Slug</TableHead><TableHead>Revision</TableHead><TableHead>Status</TableHead><TableHead>Bound to profile</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
                    <TableBody>{visibleWorkflows.map((row) => <TableRow key={row.slug + ' ' + String(row.revision)}><TableCell className="font-mono break-all">{row.slug}</TableCell><TableCell>{row.revision}</TableCell><TableCell><Badge variant={row.status === 'active' ? 'success' : 'neutral'}>{row.status}</Badge></TableCell><TableCell>{row.enabled ? 'enabled' : 'not bound'}</TableCell><TableCell className="text-xs">{row.createdAt}</TableCell></TableRow>)}</TableBody>
                  </Table>
                </TableContainer>
                <TablePagination ariaLabel="Loaded workflow schema pages" hasPreviousPage={workflowIndex > 0} hasNextPage={(workflowIndex + 1) * 20 < loadedWorkflows.length} onPreviousPage={() => setWorkflowIndex((index) => Math.max(0, index - 1))} onNextPage={() => setWorkflowIndex((index) => index + 1)} status={`Page ${workflowIndex + 1} · ${workflows.data.total} loaded workflow rows`} className="justify-end" />
              </> : null}
            </CardContent>
          </Card>
        </TabsPanel>
      </TabsRoot>
    </section>
  );
}
