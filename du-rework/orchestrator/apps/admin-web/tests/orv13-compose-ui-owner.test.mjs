import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  composeActionBlockReason,
  composeFreshness,
  composeJobStateGuidance,
  composePreviewExpired,
  composePreviewMatchesCurrent,
  composeReleasesForAction,
  composeSafeErrorMessage,
} from '../src/features/system-operations/compose-state.ts';

const now = Date.parse('2026-10-11T12:00:00.000Z');
const catalog = {
  configured: true,
  hostId: 'host-west',
  manifestDigest: 'sha256:manifest-v2',
  availability: 'FRESH',
  receivedAt: '2026-10-11T12:00:00.000Z',
  lastErrorCode: null,
  projects: [],
};
const project = {
  projectId: 'portal',
  displayName: 'Portal',
  catalogRevision: 'rev-12',
  manifestDigest: catalog.manifestDigest,
  availability: 'FRESH',
  sampledAt: '2026-10-11T11:59:50.000Z',
  receivedAt: '2026-10-11T12:00:00.000Z',
  lastErrorCode: null,
  observedDigest: 'sha256:observed-4',
  targetRevision: 4,
  desiredReleaseId: 'release-current',
  activeJob: null,
  services: [{ serviceId: 'web', displayName: 'Web', restartAllowed: true }],
  releases: [
    {
      releaseId: 'release-current', displayName: 'Current', releaseDigest: 'sha256:current',
      targetServices: ['web'], images: [{ serviceId: 'web', imageDigest: 'sha256:image-current' }],
      migrationCompatibility: 'acknowledged', rollbackAllowedFrom: [],
    },
    {
      releaseId: 'release-previous', displayName: 'Previous', releaseDigest: 'sha256:previous',
      targetServices: ['web'], images: [{ serviceId: 'web', imageDigest: 'sha256:image-previous' }],
      migrationCompatibility: 'acknowledged', rollbackAllowedFrom: ['release-current'],
    },
  ],
  observedServices: [],
};
const preview = {
  previewId: 'preview-1',
  hostId: catalog.hostId,
  projectId: project.projectId,
  action: 'apply_release',
  releaseId: 'release-next',
  serviceId: null,
  reason: 'Planned release update',
  createdAt: '2026-10-11T11:59:55.000Z',
  expiresAt: '2026-10-11T12:01:00.000Z',
  manifestDigest: catalog.manifestDigest,
  observedDigest: project.observedDigest,
  expectedTargetRevision: project.targetRevision,
  targetServices: ['web'],
  targetReleaseDigest: 'sha256:next',
  impact: { affectedServices: ['web'], downtime: 'possible', statefulServicesExcluded: true },
  warnings: ['POSSIBLE_SERVICE_INTERRUPTION'],
};

describe('UI13 Compose operator safety and freshness', () => {
  it('fails closed on unavailable, stale, invalid, and future host observations', () => {
    assert.equal(composeFreshness('UNAVAILABLE', null, null, now), 'unavailable');
    assert.equal(composeFreshness('FRESH', null, catalog.receivedAt, now), 'unknown');
    assert.equal(composeFreshness('FRESH', '2026-10-11T12:01:00.000Z', catalog.receivedAt, now), 'unknown');
    assert.equal(composeFreshness('STALE', project.sampledAt, project.receivedAt, now), 'stale');
    assert.equal(composeFreshness('FRESH', '2026-10-11T11:58:59.000Z', catalog.receivedAt, now), 'stale');
  });

  it('allows preview only for a configured, fresh, digest-matched and idle project', () => {
    assert.equal(composeActionBlockReason(catalog, project, now), null);
    assert.match(composeActionBlockReason({ ...catalog, configured: false, lastErrorCode: 'RUNNER_NOT_CONFIGURED' }, project, now), /host-side Compose runner is not configured/i);
    assert.match(composeActionBlockReason(catalog, { ...project, manifestDigest: 'sha256:other' }, now), /manifest digest does not match/i);
    assert.match(composeActionBlockReason(catalog, { ...project, activeJob: { jobId: 'job-unknown', state: 'UNKNOWN' } }, now), /holds this Compose project/i);
    assert.match(composeActionBlockReason(catalog, { ...project, sampledAt: '2026-10-11T11:58:59.000Z' }, now), /stale in this page/i);
    assert.equal(composeSafeErrorMessage('RUNNER_NOT_CONFIGURED'), 'The host-side Compose runner is not configured.');
  });

  it('offers only releases explicitly approved as rollback targets from the current desired release', () => {
    const choices = composeReleasesForAction(project, 'rollback_release');
    assert.deepEqual(choices.map((release) => release.releaseId), ['release-previous']);
    assert.deepEqual(composeReleasesForAction({ ...project, desiredReleaseId: null }, 'rollback_release'), []);
  });

  it('fences preview submission by expiry, host/project, observed digest and desired revision', () => {
    assert.equal(composePreviewMatchesCurrent(preview, catalog, project, now), true);
    assert.equal(composePreviewExpired(preview, Date.parse(preview.expiresAt)), true);
    assert.equal(composePreviewMatchesCurrent(preview, catalog, { ...project, targetRevision: 5 }, now), false);
    assert.equal(composePreviewMatchesCurrent(preview, catalog, { ...project, observedDigest: 'sha256:changed' }, now), false);
    assert.equal(composePreviewMatchesCurrent(preview, { ...catalog, hostId: 'other' }, project, now), false);
    assert.equal(composePreviewMatchesCurrent(preview, catalog, { ...project, activeJob: { jobId: 'job-2', state: 'RUNNING' } }, now), false);
  });

  it('gives UNKNOWN jobs human reconciliation guidance without a retry path', () => {
    assert.match(composeJobStateGuidance('UNKNOWN'), /Do not resubmit/i);
    assert.match(composeJobStateGuidance('UNKNOWN'), /deployment runbook/i);
    assert.match(composeJobStateGuidance('UNKNOWN'), /does not provide a shell or retry action/i);
    assert.equal(composeJobStateGuidance('QUEUED'), null);
  });
});
