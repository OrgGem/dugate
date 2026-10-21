/**
 * PC-08 — Root-grant access pane.
 *
 * Encodes the two-console model: the configuration revision never moves here,
 * and every mutation carries the CURRENT access version plus its own
 * idempotency key. The raw group key is shown exactly once, in local component
 * state, and is dropped as soon as the acknowledgement dialog closes.
 */
import { useMemo, useRef, useState } from 'react';
import type { ProfileGroupKeyGrant, ProfileGroupV2 } from '@du/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog, Modal } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AlertBanner, EmptyState, LoadingState } from '@/components/ui/state-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AdminApiClient } from '@/lib/api';
import { resolveProfileGroupV2Error } from './profile-group-state';

interface IssueResult {
  grant: ProfileGroupKeyGrant;
  secret: string | null;
  secretAvailable: boolean;
}

export interface ProfileGroupAccessPaneProps {
  client: AdminApiClient;
  group: ProfileGroupV2;
  /** False for a still-CHILD_PROJECTION group: the service refuses every write. */
  writesAllowed: boolean;
  onAccessVersionChange: (accessVersion: number) => void;
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
}

export function ProfileGroupAccessPane({
  client,
  group,
  writesAllowed,
  onAccessVersionChange,
  onReload,
  onNotice,
}: ProfileGroupAccessPaneProps) {
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueNote, setIssueNote] = useState('');
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssueResult | null>(null);
  const [secretAcknowledged, setSecretAcknowledged] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ProfileGroupKeyGrant | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const issueKeyRef = useRef<string | null>(null);
  const revokeKeyRef = useRef<string | null>(null);

  const grants = useMemo(
    () => [...group.apiKeyGrants].sort((left, right) => (left.grantedAt < right.grantedAt ? 1 : left.grantedAt > right.grantedAt ? -1 : 0)),
    [group.apiKeyGrants],
  );

  function openIssue(): void {
    issueKeyRef.current = crypto.randomUUID();
    setIssueNote('');
    setIssueError(null);
    setIssueOpen(true);
  }

  async function confirmIssue(): Promise<void> {
    if (!writesAllowed || issueBusy) return;
    const idempotencyKey = issueKeyRef.current ?? crypto.randomUUID();
    issueKeyRef.current = idempotencyKey;
    setIssueBusy(true);
    setIssueError(null);
    try {
      const result = await client.issueProfileGroupKey(
        group.groupId,
        issueNote.trim() ? { note: issueNote.trim() } : {},
        group.accessVersion,
        idempotencyKey,
      );
      if (!result.ok) {
        const copy = resolveProfileGroupV2Error(result.problem);
        setIssueError(copy.title);
        if (copy.recovery === 'reload' || copy.recovery === 'conversion_required') {
          setIssueOpen(false);
          await onReload();
        }
        return;
      }
      // The issue response never carries the new access version (it bumps it),
      // so the authoritative value is re-read before any further mutation.
      setIssueOpen(false);
      setSecretAcknowledged(result.data.secretAvailable === false);
      setIssued({
        grant: result.data.grant,
        secret: result.data.secret ?? null,
        secretAvailable: result.data.secretAvailable,
      });
      onNotice(`Issued a root grant for ${result.data.grant.prefix}.`);
      await onReload();
    } catch {
      setIssueError('The grant request outcome is unknown. Reload the group before issuing another key.');
    } finally {
      setIssueBusy(false);
    }
  }

  function closeIssued(): void {
    setIssued(null);
    setSecretAcknowledged(false);
    issueKeyRef.current = null;
  }

  async function confirmRevoke(): Promise<void> {
    const target = revokeTarget;
    if (!target || !writesAllowed || revokeBusy) return;
    const idempotencyKey = revokeKeyRef.current ?? crypto.randomUUID();
    revokeKeyRef.current = idempotencyKey;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      const result = await client.revokeProfileGroupKey(
        group.groupId,
        target.apiKeyId,
        { expectedAccessVersion: group.accessVersion },
        idempotencyKey,
      );
      if (!result.ok) {
        const copy = resolveProfileGroupV2Error(result.problem);
        setRevokeError(copy.title);
        if (copy.recovery === 'reload' || copy.recovery === 'conversion_required') {
          setRevokeTarget(null);
          await onReload();
        }
        return;
      }
      onAccessVersionChange(result.data.accessVersion);
      setRevokeTarget(null);
      revokeKeyRef.current = null;
      onNotice(`Revoked the root grant for ${target.prefix}. Access version is now ${result.data.accessVersion}.`);
      await onReload();
    } catch {
      setRevokeError('The revoke outcome is unknown. Reload the grants before trying again.');
    } finally {
      setRevokeBusy(false);
    }
  }

  return (
    <Card className="border-[var(--border-subtle)] shadow-sm">
      <CardHeader className="border-b border-[var(--border-subtle)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">Root key grants</CardTitle>
            <CardDescription>
              Keys listed here may invoke this group's functions. Issuing or revoking a grant changes the
              access version (currently {group.accessVersion}); it never changes the configuration revision.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={group.authAuthority === 'GROUP_GRANT' ? 'success' : 'warning'} dot>
              {group.authAuthority === 'GROUP_GRANT' ? 'Root-grant authority' : 'Legacy child projection'}
            </Badge>
            <Button
              type="button"
              variant="primary"
              disabled={!writesAllowed || issueBusy}
              onClick={openIssue}
              title={!writesAllowed ? 'Convert this group to root-grant authority before issuing keys.' : undefined}
            >
              Issue root key
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        {!writesAllowed ? (
          <AlertBanner variant="warning" title="This group still uses the legacy child projection">
            Configuration and root grants are read-only here. The service refuses every V2 write with
            <code className="mx-1">409 PROFILE_GROUP_V2_REQUIRED</code>
            until the group is converted by an administrative operation outside this screen.
          </AlertBanner>
        ) : null}
        {issueError ? <AlertBanner variant="error" title="Grant issue failed">{issueError}</AlertBanner> : null}
        {revokeError ? <AlertBanner variant="error" title="Grant revoke failed">{revokeError}</AlertBanner> : null}
        {grants.length === 0 ? (
          <EmptyState
            title="No root grants"
            description="Configuration stays editable without a key. Workbench submission is disabled until an active key holds a grant."
          />
        ) : (
          <TableContainer maxHeight={320} aria-label="Root key grants">
            <Table aria-label="Root key grants" density="compact">
              <TableHeader sticky>
                <TableRow>
                  <TableHead>Key prefix</TableHead>
                  <TableHead>Key id</TableHead>
                  <TableHead>Key status</TableHead>
                  <TableHead>Granted</TableHead>
                  <TableHead>Granted by</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.map((grant) => (
                  <TableRow key={grant.apiKeyId}>
                    <TableCell className="font-mono text-xs">{grant.prefix}</TableCell>
                    <TableCell className="break-all font-mono text-xs">{grant.apiKeyId}</TableCell>
                    <TableCell>
                      <Badge variant={grant.status === 'ACTIVE' ? 'success' : 'neutral'}>{grant.status}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{grant.grantedAt}</TableCell>
                    <TableCell className="text-xs">{grant.grantedBy ?? '—'}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!writesAllowed || revokeBusy}
                        onClick={() => {
                          revokeKeyRef.current = crypto.randomUUID();
                          setRevokeError(null);
                          setRevokeTarget(grant);
                        }}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        <p className="text-xs text-[var(--text-sub)]">
          Revoked grants are not projected back by the API; the revoke response is the only tombstone this
          screen can show, and it is session-local.
        </p>
      </CardContent>

      <Modal
        open={issueOpen}
        onOpenChange={(open) => { if (!open && !issueBusy) setIssueOpen(false); }}
        title="Issue a root key grant"
        description={`The key will resolve this group at access version ${group.accessVersion}. The raw value is returned exactly once.`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setIssueOpen(false)} disabled={issueBusy}>Cancel</Button>
            <Button variant="primary" onClick={() => void confirmIssue()} isLoading={issueBusy}>
              {issueBusy ? 'Issuing…' : 'Issue root key'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <FormField label="Note (optional)" description="The API does not project the note back after issue.">
            <Input
              aria-label="Grant note"
              value={issueNote}
              maxLength={200}
              disabled={issueBusy}
              onChange={(event) => setIssueNote(event.target.value)}
            />
          </FormField>
        </div>
      </Modal>

      <Modal
        open={issued !== null}
        onOpenChange={(open) => {
          if (open) return;
          // A shown secret must be acknowledged before the dialog can close.
          if (issued?.secretAvailable !== false && !secretAcknowledged) return;
          closeIssued();
        }}
        title={issued?.secretAvailable === false ? 'Grant already issued' : 'Root key issued once'}
        description={
          issued?.secretAvailable === false
            ? 'This issue was replayed by an idempotent retry, so the secret cannot be shown again.'
            : 'Copy this key now. It cannot be displayed again, and it is not stored in the browser.'
        }
        footer={
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!secretAcknowledged && issued?.secretAvailable === true}
              onClick={closeIssued}
            >
              {issued?.secretAvailable === false ? 'Close' : 'I have stored this key'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          {issued ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-[var(--text-sub)]">Key prefix</dt>
                <dd className="font-mono">{issued.grant.prefix}</dd>
                <dt className="text-[var(--text-sub)]">Key id</dt>
                <dd className="break-all font-mono text-xs">{issued.grant.apiKeyId}</dd>
                <dt className="text-[var(--text-sub)]">Status</dt>
                <dd>{issued.grant.status}</dd>
              </dl>
              {issued.secret ? (
                <div className="space-y-2">
                  <AlertBanner variant="warning" title="Copy once">This is the only time the raw key crosses the wire.</AlertBanner>
                  <textarea
                    aria-label="Issued group key"
                    readOnly
                    className="min-h-20 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] p-2 font-mono text-xs"
                    value={issued.secret}
                  />
                  {secretAcknowledged ? (
                    <p role="status" className="text-xs text-[var(--text-sub)]">Acknowledged. Close this dialog to clear it from the page.</p>
                  ) : (
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={secretAcknowledged}
                        onChange={(event) => setSecretAcknowledged(event.target.checked)}
                      />
                      I copied this key and understand it cannot be shown again.
                    </label>
                  )}
                </div>
              ) : null}
            </>
          ) : <LoadingState title="Preparing the issue result" />}
        </div>
      </Modal>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => { if (!open && !revokeBusy) setRevokeTarget(null); }}
        title={`Revoke the grant for ${revokeTarget?.prefix ?? 'this key'}?`}
        description={`The key stops authorizing this group at access version ${group.accessVersion}. In-flight operations keep their pinned resolution; configuration is untouched.`}
        confirmText="Revoke grant"
        cancelText="Keep grant"
        variant="destructive"
        isLoading={revokeBusy}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => setRevokeTarget(null)}
      />
    </Card>
  );
}
