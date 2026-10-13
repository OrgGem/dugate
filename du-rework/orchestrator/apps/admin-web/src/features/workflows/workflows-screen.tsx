import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Workflow,
  GitBranch,
  Play,
  Plus,
  RefreshCw,
  Copy,
  Check,
  Layers,
  ArrowRight,
  Code2,
  Trash2,
  CheckCircle2,
  CircleAlert,
  HelpCircle,
  Boxes,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog, Modal } from '@/components/ui/dialog';
import { AlertBanner, LoadingState, EmptyState, ErrorState } from '@/components/ui/state-panel';
import {
  createAdminApiClient,
  type WorkflowCatalogItem,
  type ApiKeyRow,
} from '@/lib/api';
import { loadActiveKeys } from '@/lib/api/active-keys';
import { useTenant } from '@/lib/tenant-context';
import { parseBusinessPage, parseBusinessVersions } from '@/features/businesses/state';
import { checkWorkflowSchemaDraft, connectorNodeAtPath, connectorReferences, parseWorkflowOverrideRows, updateConnectorNodeOverride, updateConnectorReference, workflowSchemaDiff, type WorkflowExtraHeader, type WorkflowStaticFormField } from './revision-editor';
import { acceptAttempt, createImmutableAttempt, FileArtifactCache, markAttemptDispatched, retainAfterFailure, TenantAttemptRegistry, type ImmutableAttempt } from '@/features/submissions/immutable-attempt';

export interface PresetSample {
  slug: string;
  name: string;
  description: string;
  badge: string;
  schema: {
    slug: string;
    name: string;
    version: number;
    description: string;
    input_schema: {
      type: 'object';
      properties: Record<string, { type: string; label: string; description?: string; default?: unknown }>;
    };
    nodes: Array<{
      id: string;
      type: 'connector';
      description: string;
      connector: string;
      overrideConnector?: {
        prompt?: string;
        timeoutSec?: number;
      };
    }>;
    flow: string[];
    output: {
      from: string;
    };
  };
}

type WorkflowTestSource = 'backend' | 'simulation';

interface WorkflowImportPreview {
  tenantId: string;
  format: 'json' | 'xml';
  schema: Record<string, unknown>;
  connectorNames: string[];
  egress: Array<{ nodeId: string; kind: 'callback' | 'file_url_download'; staticOrigins: string[]; dynamic: boolean }>;
  sourceDigest: string;
}

type WorkflowTestRequest = {
  tenantId: string;
  slug: string;
  expectedRevision: number;
  apiKeyId: string;
  artifacts: Array<{ artifactId: string; role: string }>;
  variables: Record<string, unknown>;
};
type WorkflowTestAttempt = ImmutableAttempt<WorkflowTestRequest>;

const PRESET_SAMPLES: PresetSample[] = [
  {
    slug: 'doc-processing-pipeline',
    name: 'Intelligent Document Processing (IDP)',
    description: 'End-to-end document processing: ingestion, AI entity extraction and automatic policy compliance checks.',
    badge: 'Recommended For Business',
    schema: {
      slug: 'doc-processing-pipeline',
      name: 'Intelligent Document Processing Pipeline',
      version: 1,
      description: 'End-to-end automated document processing: Ingestion, entity extraction, and policy rule verification.',
      input_schema: {
        type: 'object',
        properties: {
          document_type: { type: 'string', label: 'Document type', description: 'Type of document (contract, invoice, minutes)', default: 'contract' },
          priority: { type: 'string', label: 'Processing priority', default: 'high' },
          auto_verify: { type: 'boolean', label: 'Automatic clause verification', default: true },
        },
      },
      nodes: [
        {
          id: 'ingest_step',
          type: 'connector',
          description: 'Ingest the document and analyse the structure of PDF, Word and scanned formats',
          connector: 'document-core',
          overrideConnector: {
            prompt: 'Ingest document and structure content into AI-ready markdown pages',
            timeoutSec: 120,
          },
        },
        {
          id: 'extract_step',
          type: 'connector',
          description: 'Extract entities, tables, dates and the parties involved',
          connector: 'document-core',
          overrideConnector: {
            prompt: 'Extract structured metadata, key-value pairs, dates, amounts, and clauses',
            timeoutSec: 180,
          },
        },
        {
          id: 'compliance_verify',
          type: 'connector',
          description: 'Check compliance rules and flag discrepancies in the clauses',
          connector: 'lc-checker',
          overrideConnector: {
            prompt: 'Verify clauses, check compliance policies, and flag any discrepancies',
            timeoutSec: 120,
          },
        },
      ],
      flow: ['ingest_step', 'extract_step', 'compliance_verify'],
      output: {
        from: 'compliance_verify',
      },
    },
  },
  {
    slug: 'lc-compliance-audit',
    name: 'Letter Of Credit & Contract Audit',
    description: 'Inspection of import and export documents, reconciling LC clauses against international banking standards.',
    badge: 'Finance & Banking',
    schema: {
      slug: 'lc-compliance-audit',
      name: 'Letter of Credit Compliance & Discrepancy Audit',
      version: 1,
      description: 'Document verification and discrepancy check against international banking rules.',
      input_schema: {
        type: 'object',
        properties: {
          lc_number: { type: 'string', label: 'Letter Of Credit (LC) Number', default: 'LC-2026-X889' },
          issuing_bank: { type: 'string', label: 'Issuing bank', default: 'Standard Chartered' },
          tolerance_percentage: { type: 'number', label: 'Tolerance percentage (%)', default: 5 },
        },
      },
      nodes: [
        {
          id: 'parse_doc',
          type: 'connector',
          description: 'Parse and break down the shipping documents and commercial invoices',
          connector: 'document-core',
          overrideConnector: {
            prompt: 'Extract shipping documents, commercial invoices, and bill of lading terms',
          },
        },
        {
          id: 'lc_rule_checker',
          type: 'connector',
          description: 'Check against the UCP 600 rules and flag discrepancies in the data',
          connector: 'lc-checker',
          overrideConnector: {
            prompt: 'Check compliance with LC terms, verify dates, amounts, ports, and beneficiary names',
          },
        },
        {
          id: 'human_audit_review',
          type: 'connector',
          description: 'Compile the audit report and the risk matrix',
          connector: 'example-review',
          overrideConnector: {
            prompt: 'Compile discrepancy matrix and recommendations for trade specialist review',
          },
        },
      ],
      flow: ['parse_doc', 'lc_rule_checker', 'human_audit_review'],
      output: {
        from: 'human_audit_review',
      },
    },
  },
  {
    slug: 'ocr-markdown-transform',
    name: 'AI OCR Extraction & Markdown Conversion',
    description: 'Converts scanned documents and images into clean Markdown text for large language models.',
    badge: 'High Speed',
    schema: {
      slug: 'ocr-markdown-transform',
      name: 'Fast OCR & Markdown Clean Transform',
      version: 1,
      description: 'High-speed OCR scan and clean markdown conversion pipeline.',
      input_schema: {
        type: 'object',
        properties: {
          clean_tables: { type: 'boolean', label: 'Normalize table formatting', default: true },
          preserve_headers: { type: 'boolean', label: 'Preserve the H1-H4 heading structure', default: true },
        },
      },
      nodes: [
        {
          id: 'ocr_scan',
          type: 'connector',
          description: 'Run multilingual OCR character recognition',
          connector: 'document-core',
          overrideConnector: {
            prompt: 'Perform high-fidelity OCR, extract text layout and table structures',
          },
        },
        {
          id: 'markdown_clean',
          type: 'connector',
          description: 'Clean up and restructure into standard Markdown format',
          connector: 'document-core',
          overrideConnector: {
            prompt: 'Normalize into semantic Markdown with proper tables and headings',
          },
        },
      ],
      flow: ['ocr_scan', 'markdown_clean'],
      output: {
        from: 'markdown_clean',
      },
    },
  },
];

export function WorkflowsScreen() {
  const client = useMemo(() => createAdminApiClient(), []);
  const { tenantId } = useTenant();

  const [workflowItems, setWorkflows] = useState<WorkflowCatalogItem[]>([]);
  const [catalogTenantId, setCatalogTenantId] = useState<string | null>(tenantId);
  const workflows = catalogTenantId === tenantId ? workflowItems : [];
  const [loading, setLoading] = useState(true);
  const [catalogLoadError, setCatalogLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [businesses, setBusinesses] = useState<string[]>([]);
  const [businessVersions, setBusinessVersions] = useState<string[]>([]);
  const [ownerBusinessId, setOwnerBusinessId] = useState('');
  const [ownerBusinessVersion, setOwnerBusinessVersion] = useState('');

  const [selectedWorkflowState, setSelectedWorkflow] = useState<WorkflowCatalogItem | null>(null);
  const selectedWorkflow = catalogTenantId === tenantId ? selectedWorkflowState : null;
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importSourceText, setImportSourceText] = useState('');
  const [importFormat, setImportFormat] = useState<'json' | 'xml'>('json');
  const [importPreview, setImportPreview] = useState<WorkflowImportPreview | null>(null);
  const [importPreviewSource, setImportPreviewSource] = useState<{ source: string; format: 'json' | 'xml'; tenantId: string } | null>(null);
  const [importPreviewBusy, setImportPreviewBusy] = useState(false);
  const [approvedStaticOrigins, setApprovedStaticOrigins] = useState<string[]>([]);
  const [dynamicOriginDrafts, setDynamicOriginDrafts] = useState<Record<string, string>>({});
  const [importError, setImportError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [sessionRole, setSessionRole] = useState<'admin' | 'operator' | 'viewer'>('viewer');
  const [sessionPrincipalKind, setSessionPrincipalKind] = useState<'platform' | 'tenant_operator' | 'unscoped'>('unscoped');
  const canManageCatalog = sessionRole === 'admin' && sessionPrincipalKind === 'platform';
  const importPreviewCurrent = Boolean(importPreview && importPreviewSource
    && importPreviewSource.source === importSourceText
    && importPreviewSource.format === importFormat
    && importPreviewSource.tenantId === tenantId);
  const previewStaticOrigins = [...new Set(importPreview?.egress.flatMap(item => item.staticOrigins) ?? [])];
  const importEgressApproved = importPreviewCurrent
    && previewStaticOrigins.every(origin => approvedStaticOrigins.includes(origin))
    && (importPreview?.egress.filter(item => item.dynamic) ?? []).every(item => Boolean(dynamicOriginDrafts[item.nodeId]?.trim()));
  const [catalogSearch, setCatalogSearch] = useState('');
  const [retireTarget, setRetireTarget] = useState<WorkflowCatalogItem | null>(null);
  const [discardRevisionOpen, setDiscardRevisionOpen] = useState(false);
  const [revisionEditorOpen, setRevisionEditorOpen] = useState(false);
  const [revisionTarget, setRevisionTarget] = useState<{ tenantId: string; scopeTenantId: string | null; slug: string; revision: number; name: string } | null>(null);
  const [revisionOriginal, setRevisionOriginal] = useState('');
  const [revisionDraft, setRevisionDraft] = useState('');
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [revisionBaseLoading, setRevisionBaseLoading] = useState(false);
  const catalogRequest = useRef(0);
  const catalogActionGeneration = useRef(0);
  const catalogActionInFlight = useRef(false);
  const activeTenant = useRef(tenantId);
  activeTenant.current = tenantId;
  const workflowActionKeys = useRef(new Map<string, string>());

  // Test execution state
  const [testModalOpen, setTestModalOpen] = useState(false);
  const testRequest = useRef(0);
  const [testVariablesJson, setTestVariablesJson] = useState('{}');
  const [testInputVariables, setTestInputVariables] = useState<Record<string, unknown>>({});
  const [testSource, setTestSource] = useState<WorkflowTestSource>('backend');
  const [testKeys, setTestKeys] = useState<ApiKeyRow[]>([]);
  const [testApiKeyId, setTestApiKeyId] = useState('');
  const [testFiles, setTestFiles] = useState<File[]>([]);
  const [testArtifacts, setTestArtifacts] = useState('[]');
  const [metadataConfigured, setMetadataConfigured] = useState<boolean | null>(null);
  const [testExecuting, setTestExecuting] = useState(false);
  const inFlightTestTenants = useRef(new Set<string>());
  const testAttempts = useRef(new TenantAttemptRegistry<WorkflowTestAttempt>());
  const uploadedTestFiles = useRef(new FileArtifactCache<File>());
  const [testAttempt, setTestAttempt] = useState<WorkflowTestAttempt | null>(null);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [copiedDigest, setCopiedDigest] = useState<string | null>(null);

  const revisionCheck = useMemo(
    () => revisionTarget ? checkWorkflowSchemaDraft(revisionDraft, revisionTarget.slug) : { ok: false as const, message: 'Select an active workflow revision to edit.' },
    [revisionDraft, revisionTarget],
  );
  const revisionSchema = revisionCheck.ok ? revisionCheck.schema : null;
  const revisionConnectors = useMemo(() => revisionSchema ? connectorReferences(revisionSchema) : [], [revisionSchema]);
  const revisionDiff = useMemo(() => workflowSchemaDiff(revisionOriginal, revisionDraft), [revisionOriginal, revisionDraft]);
  const filteredWorkflows = useMemo(() => {
    const query = catalogSearch.trim().toLocaleLowerCase();
    if (!query) return workflows;
    return workflows.filter((workflow) => [workflow.name, workflow.slug, workflow.description]
      .some((value) => typeof value === 'string' && value.toLocaleLowerCase().includes(query)));
  }, [catalogSearch, workflows]);

  useEffect(() => {
    let active = true;
    void client.getSession().then(result => {
      if (!active || !result.ok) return;
      setSessionRole(result.data.role);
      setSessionPrincipalKind(result.data.principal.kind);
    });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    let active = true; testRequest.current++; setTestExecuting(inFlightTestTenants.current.has(tenantId ?? '')); setTestKeys([]); setTestFiles([]); setTestArtifacts('[]'); setTestApiKeyId(''); setTestResult(null); setTestModalOpen(false);
    setTestAttempt(null);
    if (tenantId) void loadActiveKeys(client, tenantId, () => !active).then(keys => { if (active) setTestKeys(keys); }).catch(error => { if (active) setError(error instanceof Error ? error.message : 'API keys unavailable'); });
    return () => { active = false; };
  }, [client, tenantId]);
  useEffect(() => { void client.getSettings().then(result => {
    if (result.ok) { const caps = result.data.capabilities as Record<string, unknown> | undefined; setMetadataConfigured(caps?.metadataEncryptionConfigured === true); }
  }); }, [client]);
  const testOperationId = testAttempt?.state === 'ACCEPTED' && testAttempt.operationId
    ? testAttempt.operationId
    : typeof testResult?.operationId === 'string' ? testResult.operationId : null;
  useEffect(() => {
    if (!testModalOpen || !testOperationId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const result = await client.getOperation(testOperationId);
      if (cancelled) return;
      if (!result.ok) { setTestResult(previous => ({ ...previous, pollingError: result.problem.title ?? 'Result polling failed; retry by reopening operation details.' })); return; }
      const raw = result.data as unknown as Record<string, unknown>;
      const operation = (raw.operation && typeof raw.operation === 'object' ? raw.operation : raw) as Record<string, unknown>;
      const state = String(operation.state ?? 'UNKNOWN');
      setTestResult(previous => ({ ...previous, status: state, message: `Operation ${testOperationId}: ${state}`, result: raw, pollingError: undefined }));
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(state)) {
        if (testAttempt?.state === 'ACCEPTED' && testAttempt.operationId === testOperationId) {
          if (testAttempts.current.clearAcceptedOperation(testAttempt.tenantId, testOperationId)
            && activeTenant.current === testAttempt.tenantId) setTestAttempt(null);
        }
      } else timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, testAttempt, testModalOpen, testOperationId]);

  const fetchWorkflows = async (preferredSlug?: string) => {
    const tenantScope = tenantId;
    const request = ++catalogRequest.current;
    setCatalogTenantId(tenantScope);
    setLoading(true);
    setCatalogLoadError(false);
    setError(null);
    try {
      const res = await client.listWorkflows(tenantScope ? { tenantId: tenantScope } : undefined);
      if (request !== catalogRequest.current || tenantScope !== activeTenant.current) return;
      if (res.ok) {
        const items = res.data.items ?? [];
        setWorkflows(items);
        if (items.length > 0) {
          setSelectedWorkflow((prev) => {
            const targetSlug = preferredSlug ?? prev?.slug;
            if (targetSlug && items.some((i) => i.slug === targetSlug && i.status === 'active')) {
              return items.find((i) => i.slug === targetSlug && i.status === 'active') ?? items[0] ?? null;
            }
            return items[0] ?? null;
          });
        } else {
          setSelectedWorkflow(null);
        }
      } else {
        setCatalogLoadError(true);
        setError(res.problem?.title || res.problem?.code || 'Unable to load the workflow list.');
      }
    } catch (e) {
      if (request !== catalogRequest.current || tenantScope !== activeTenant.current) return;
      setCatalogLoadError(true);
      setError(e instanceof Error ? e.message : 'API connection error');
    } finally {
      if (request === catalogRequest.current && tenantScope === activeTenant.current) setLoading(false);
    }
  };

  useEffect(() => {
    catalogRequest.current++;
    catalogActionGeneration.current++;
    catalogActionInFlight.current = false;
    setCatalogTenantId(tenantId);
    setWorkflows([]);
    setSelectedWorkflow(null);
    setCatalogSearch('');
    setActionInProgress(null);
    setCatalogLoadError(false);
    setError(null);
    setSuccessMsg(null);
    setRetireTarget(null);
    setDiscardRevisionOpen(false);
    setRevisionEditorOpen(false);
    setRevisionTarget(null);
    setRevisionOriginal('');
    setRevisionDraft('');
    setRevisionError(null);
    setRevisionConflict(false);
    setRevisionBaseLoading(false);
    void fetchWorkflows();
  }, [tenantId]);

  useEffect(() => {
    let active = true;
    setBusinesses([]);
    setOwnerBusinessId('');
    setOwnerBusinessVersion('');
    void client.listBusinesses(tenantId ? { tenantId } : undefined).then((result) => {
      if (!active) return;
      const page = result.ok ? parseBusinessPage(result.data) : null;
      setBusinesses(page?.items.map((business) => business.businessId) ?? []);
    });
    return () => { active = false; };
  }, [client, tenantId]);

  useEffect(() => {
    let active = true;
    setBusinessVersions([]);
    setOwnerBusinessVersion('');
    if (!ownerBusinessId) return () => { active = false; };
    void client.getBusinessVersions(ownerBusinessId).then((result) => {
      if (!active) return;
      const versions = result.ok ? parseBusinessVersions(result.data) : null;
      const list = versions?.rows.map((row) => row.version) ?? [];
      setBusinessVersions(list);
      setOwnerBusinessVersion(list[0] ?? '');
    });
    return () => { active = false; };
  }, [client, ownerBusinessId]);

  const handleCopyDigest = (digest: string) => {
    void navigator.clipboard.writeText(digest);
    setCopiedDigest(digest);
    setTimeout(() => setCopiedDigest(null), 2000);
  };

  const handleProvisionPreset = async (preset: PresetSample) => {
    if (!tenantId || !canManageCatalog || actionInProgress || catalogActionInFlight.current) {
      if (!canManageCatalog) setError('Workflow provisioning requires a platform administrator session.');
      else if (!tenantId) setError('Select an Organization / Tenant before activating a workflow.');
      return;
    }
    const tenantScope = tenantId;
    if (ownerBusinessId && !ownerBusinessVersion) {
      setError('Select a registered business version or clear the business assignment.');
      return;
    }
    const actionRequest = ++catalogActionGeneration.current;
    catalogActionInFlight.current = true;
    setActionInProgress(preset.slug);
    setError(null);
    setSuccessMsg(null);
    const actionScope = `${tenantScope}:workflow.provision:new:${preset.slug}`;
    const idempotencyKey = workflowActionKeys.current.get(actionScope) ?? crypto.randomUUID();
    workflowActionKeys.current.set(actionScope, idempotencyKey);
    try {
      const res = await client.provisionWorkflow({
        tenantId: tenantScope,
        ...(ownerBusinessId ? { businessId: ownerBusinessId, businessVersion: ownerBusinessVersion } : {}),
        schema: preset.schema,
        expectedRevision: null,
      }, idempotencyKey);
      if (actionRequest !== catalogActionGeneration.current || tenantScope !== activeTenant.current) return;
      if (res.ok) {
        workflowActionKeys.current.delete(actionScope);
        setSuccessMsg(`Provisioned the sample workflow "${preset.name}" (${preset.slug} v1)!`);
        await fetchWorkflows(preset.slug);
      } else {
        setError(res.problem?.title || res.problem?.code || 'Failed to provision the workflow');
      }
    } catch (e) {
      if (actionRequest === catalogActionGeneration.current && tenantScope === activeTenant.current) setError(e instanceof Error ? e.message : 'Error while provisioning the workflow');
    } finally {
      if (actionRequest === catalogActionGeneration.current) setActionInProgress(null);
      if (actionRequest === catalogActionGeneration.current) catalogActionInFlight.current = false;
    }
  };

  const handleImportPreview = async () => {
    if (!tenantId || !canManageCatalog || importPreviewBusy) {
      setImportError(!canManageCatalog ? 'Workflow import preview requires a platform administrator session.' : 'Select a Tenant first.');
      return;
    }
    setImportError(null);
    setImportPreview(null);
    setImportPreviewSource(null);
    setApprovedStaticOrigins([]);
    setDynamicOriginDrafts({});
    setImportPreviewBusy(true);
    try {
      const result = await client.previewWorkflowImport({ tenantId, format: importFormat, source: importSourceText });
      if (activeTenant.current !== tenantId) return;
      if (!result.ok) {
        setImportError(`${result.problem.title ?? 'Workflow preview failed'}${result.problem.code ? ` (${result.problem.code})` : ''}`);
        return;
      }
      const preview = result.data as unknown as WorkflowImportPreview;
      if (preview.tenantId !== tenantId || preview.format !== importFormat || !preview.schema || typeof preview.sourceDigest !== 'string') {
        setImportError('The server returned a preview for a different tenant or source format. Nothing was provisioned.');
        return;
      }
      setImportPreview(preview);
      setImportPreviewSource({ source: importSourceText, format: importFormat, tenantId });
    } catch (error) {
      if (activeTenant.current === tenantId) setImportError(error instanceof Error ? error.message : 'Workflow preview could not be reached.');
    } finally {
      setImportPreviewBusy(false);
    }
  };

  const handleImportSubmit = async () => {
    if (!tenantId || !canManageCatalog || actionInProgress || catalogActionInFlight.current) {
      setImportError(!canManageCatalog ? 'Workflow creation requires a platform administrator session.' : 'Select a Tenant first.');
      return;
    }
    if (ownerBusinessId && !ownerBusinessVersion) {
      setImportError('Select a registered business version or clear the business assignment.');
      return;
    }
    setImportError(null);
    if (!importPreview || !importPreviewSource
        || importPreviewSource.source !== importSourceText
        || importPreviewSource.format !== importFormat
        || importPreviewSource.tenantId !== tenantId) {
      setImportError('Preview this exact source again before provisioning.');
      return;
    }
    const schemaSlug = typeof importPreview.schema.slug === 'string' ? importPreview.schema.slug : '';
    if (!schemaSlug) { setImportError('The preview did not return a workflow slug.'); return; }
    const dynamicOrigins: string[] = [];
    for (const requirement of importPreview.egress.filter(item => item.dynamic)) {
      const lines = (dynamicOriginDrafts[requirement.nodeId] ?? '').split('\n').map(value => value.trim()).filter(Boolean);
      if (lines.length === 0) {
        setImportError(`Add at least one explicit HTTPS origin for dynamic URLs in node "${requirement.nodeId}".`);
        return;
      }
      for (const value of lines) {
        let parsed: URL;
        try { parsed = new URL(value); } catch { setImportError(`"${value}" is not a valid origin for node "${requirement.nodeId}".`); return; }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.pathname !== '/' || parsed.search) {
          setImportError(`Use an HTTPS origin only (for example https://example.test) for node "${requirement.nodeId}".`);
          return;
        }
        dynamicOrigins.push(parsed.origin);
      }
    }
    const staticOrigins = [...new Set(importPreview.egress.flatMap(item => item.staticOrigins))];
    if (staticOrigins.some(origin => !approvedStaticOrigins.includes(origin))) {
      setImportError('Review and approve every static egress origin shown in the preview.');
      return;
    }
    const approvedEgressOrigins = [...new Set([...staticOrigins, ...dynamicOrigins])];
    if (approvedEgressOrigins.length > 16) {
      setImportError('The workflow can pin at most 16 approved egress origins.');
      return;
    }
    if (workflows.some(workflow => workflow.slug === schemaSlug && workflow.status === 'active')) {
      setImportError(`Workflow "${schemaSlug}" already has an active revision. Open that revision and use Edit active revision to publish with a revision check.`);
      return;
    }
    const tenantScope = tenantId;
    const actionRequest = ++catalogActionGeneration.current;
    catalogActionInFlight.current = true;
    const actionScope = `${tenantScope}:workflow.provision:new:${schemaSlug}:${importPreview.sourceDigest}:${approvedEgressOrigins.join(',')}`;
    const idempotencyKey = workflowActionKeys.current.get(actionScope) ?? crypto.randomUUID();
    workflowActionKeys.current.set(actionScope, idempotencyKey);
    setActionInProgress('custom-import');
    try {
      const res = await client.provisionWorkflow({
        tenantId: tenantScope,
        ...(ownerBusinessId ? { businessId: ownerBusinessId, businessVersion: ownerBusinessVersion } : {}),
        schema: importPreview.schema,
        ...(approvedEgressOrigins.length ? { approvedEgressOrigins } : {}),
        expectedRevision: null,
      }, idempotencyKey);
      if (actionRequest !== catalogActionGeneration.current || tenantScope !== activeTenant.current) return;
      if (res.ok) {
        workflowActionKeys.current.delete(actionScope);
        setImportModalOpen(false);
        setImportSourceText('');
        setImportPreview(null);
        setImportPreviewSource(null);
        setApprovedStaticOrigins([]);
        setDynamicOriginDrafts({});
        setSuccessMsg(`Validated ${importFormat.toUpperCase()} import and created immutable workflow revision ${schemaSlug}.`);
        await fetchWorkflows(schemaSlug);
      } else {
        const conflict = res.status === 409 || Boolean(res.problem.code?.includes('CONFLICT'));
        setImportError(conflict
          ? 'The catalog changed while creating this workflow. Refresh the catalog and review the active revision before trying again.'
          : res.problem?.title || res.problem?.code || 'The workflow schema failed validation.');
      }
    } catch (e) {
      if (actionRequest === catalogActionGeneration.current && tenantScope === activeTenant.current) setImportError(e instanceof Error ? e.message : 'Error while saving the workflow');
    } finally {
      if (actionRequest === catalogActionGeneration.current) setActionInProgress(null);
      if (actionRequest === catalogActionGeneration.current) catalogActionInFlight.current = false;
    }
  };

  const handleRetireWorkflow = async (wf: WorkflowCatalogItem) => {
    if (!canManageCatalog || actionInProgress || catalogActionInFlight.current || !wf.tenantId) return;
    const tenantScope = tenantId;
    const actionRequest = ++catalogActionGeneration.current;
    catalogActionInFlight.current = true;
    setActionInProgress(wf.slug);
    setError(null);
    const actionScope = `${wf.tenantId}:workflow.retire:${wf.slug}:${wf.revision}`;
    const idempotencyKey = workflowActionKeys.current.get(actionScope) ?? crypto.randomUUID();
    workflowActionKeys.current.set(actionScope, idempotencyKey);
    try {
      const res = await client.retireWorkflow({
        tenantId: wf.tenantId,
        slug: wf.slug,
        expectedRevision: wf.revision,
      }, idempotencyKey);
      if (actionRequest !== catalogActionGeneration.current || tenantScope !== activeTenant.current) return;
      if (res.ok) {
        workflowActionKeys.current.delete(actionScope);
        setRetireTarget(null);
        setSuccessMsg(`Retired workflow "${wf.slug}" revision ${wf.revision}.`);
        await fetchWorkflows();
      } else {
        setError(res.status === 409 || Boolean(res.problem.code?.includes('CONFLICT'))
          ? 'This revision changed before retirement. Refresh the catalog and review its current active revision.'
          : res.problem?.title || res.problem?.code || 'Error while retiring the workflow');
      }
    } catch (e) {
      if (actionRequest === catalogActionGeneration.current && tenantScope === activeTenant.current) setError(e instanceof Error ? e.message : 'Connection error');
    } finally {
      if (actionRequest === catalogActionGeneration.current) setActionInProgress(null);
      if (actionRequest === catalogActionGeneration.current) catalogActionInFlight.current = false;
    }
  };

  const openRevisionEditor = (wf: WorkflowCatalogItem) => {
    if (!canManageCatalog || wf.status !== 'active' || !wf.tenantId || !wf.schema || typeof wf.schema !== 'object') return;
    const raw = JSON.stringify(wf.schema, null, 2);
    setRevisionTarget({ tenantId: wf.tenantId, scopeTenantId: tenantId, slug: wf.slug, revision: wf.revision, name: wf.name || wf.slug });
    setRevisionOriginal(raw);
    setRevisionDraft(raw);
    setRevisionError(null);
    setRevisionConflict(false);
    setRevisionBaseLoading(false);
    setRevisionEditorOpen(true);
  };

  const updateRevisionField = (field: 'name' | 'description', value: string) => {
    if (!revisionCheck.ok) return;
    setRevisionError(null);
    setRevisionDraft(JSON.stringify({ ...revisionCheck.schema, [field]: value }, null, 2));
  };

  const updateGuidedOverrideRows = (
    nodePath: Array<string | number>,
    field: 'staticFormFields' | 'extraHeaders',
    rows: Array<WorkflowStaticFormField | WorkflowExtraHeader>,
  ) => {
    if (!revisionSchema) return;
    try {
      setRevisionError(null);
      const encoded = rows.length > 0 ? JSON.stringify(rows) : undefined;
      setRevisionDraft(JSON.stringify(updateConnectorNodeOverride(revisionSchema, nodePath, field, encoded), null, 2));
    } catch (error) {
      setRevisionError(error instanceof Error ? error.message : 'Could not update these node override rows.');
    }
  };

  const saveRevision = async () => {
    if (!canManageCatalog || actionInProgress || catalogActionInFlight.current || !revisionTarget || !revisionCheck.ok) return;
    if (revisionTarget.scopeTenantId !== activeTenant.current || (tenantId !== null && revisionTarget.scopeTenantId !== tenantId)) {
      setRevisionError('Tenant scope changed. Close this editor and load the workflow from the current tenant.');
      return;
    }
    const target = revisionTarget;
    const actionRequest = ++catalogActionGeneration.current;
    catalogActionInFlight.current = true;
    const actionScope = `${target.tenantId}:workflow.provision:${target.slug}:${target.revision}:${revisionDraft}`;
    const idempotencyKey = workflowActionKeys.current.get(actionScope) ?? crypto.randomUUID();
    workflowActionKeys.current.set(actionScope, idempotencyKey);
    setActionInProgress(`revision:${target.slug}`);
    setRevisionError(null);
    setError(null);
    try {
      const result = await client.provisionWorkflow({
        tenantId: target.tenantId,
        schema: revisionCheck.schema,
        expectedRevision: target.revision,
      }, idempotencyKey);
      if (actionRequest !== catalogActionGeneration.current || target.scopeTenantId !== activeTenant.current) return;
      if (!result.ok) {
        const conflict = result.status === 409 || Boolean(result.problem.code?.includes('CONFLICT'));
        setRevisionConflict(conflict);
        setRevisionError(conflict
          ? `Revision ${target.revision} is no longer active. Your draft is preserved; refresh the catalog, compare the new revision, then reopen the editor.`
          : result.problem.title || result.problem.code || 'The server rejected this workflow revision. Your draft is preserved.');
        return;
      }
      workflowActionKeys.current.delete(actionScope);
      setRevisionEditorOpen(false);
      setRevisionTarget(null);
      setSuccessMsg(`Published a new immutable revision for "${target.slug}" using expected revision ${target.revision}.`);
      await fetchWorkflows(target.slug);
    } catch (error) {
      if (actionRequest === catalogActionGeneration.current && target.scopeTenantId === activeTenant.current) {
        setRevisionError(error instanceof Error ? error.message : 'The revision result is unknown. Refresh the catalog before submitting again.');
      }
    } finally {
      if (actionRequest === catalogActionGeneration.current) setActionInProgress(null);
      if (actionRequest === catalogActionGeneration.current) catalogActionInFlight.current = false;
    }
  };

  const refreshRevisionBase = async () => {
    if (!canManageCatalog || catalogActionInFlight.current || !revisionTarget) return;
    const target = revisionTarget;
    const actionRequest = ++catalogActionGeneration.current;
    catalogActionInFlight.current = true;
    setRevisionBaseLoading(true);
    setActionInProgress(`revision-base:${target.slug}`);
    try {
      const result = await client.getWorkflow(target.slug, { tenantId: target.tenantId });
      if (actionRequest !== catalogActionGeneration.current || target.scopeTenantId !== activeTenant.current) return;
      if (!result.ok || !result.data.active?.schema || typeof result.data.active.schema !== 'object') {
        setRevisionError(result.ok ? 'No active workflow schema is available to compare with this draft.' : result.problem.title || 'The active workflow revision could not be loaded.');
        return;
      }
      const active = result.data.active;
      setRevisionOriginal(JSON.stringify(active.schema, null, 2));
      setRevisionTarget({ ...target, revision: active.revision, name: active.name || active.slug });
      setRevisionConflict(false);
      setRevisionError(`Loaded active revision ${active.revision} as the new compare-and-swap base. Your draft is preserved; review the updated diff before publishing.`);
    } catch (error) {
      if (actionRequest === catalogActionGeneration.current && target.scopeTenantId === activeTenant.current) {
        setRevisionError(error instanceof Error ? error.message : 'The active workflow revision could not be loaded. Your draft is preserved.');
      }
    } finally {
      if (actionRequest === catalogActionGeneration.current) {
        setRevisionBaseLoading(false);
        setActionInProgress(null);
        catalogActionInFlight.current = false;
      }
    }
  };

  const requestCloseRevisionEditor = () => {
    if (actionInProgress) return;
    if (revisionDraft !== revisionOriginal) {
      setDiscardRevisionOpen(true);
      return;
    }
    setRevisionEditorOpen(false);
    setRevisionTarget(null);
  };

  const discardRevisionDraft = () => {
    setDiscardRevisionOpen(false);
    setRevisionEditorOpen(false);
    setRevisionTarget(null);
    setRevisionOriginal('');
    setRevisionDraft('');
    setRevisionError(null);
    setRevisionConflict(false);
  };

  function storeWorkflowTestAttempt(previous: WorkflowTestAttempt, next: WorkflowTestAttempt | null): void {
    const scope = previous.tenantId;
    if (testAttempts.current.set(scope, next) && activeTenant.current === previous.tenantId) setTestAttempt(next);
  }

  const openTestModal = (wf: WorkflowCatalogItem) => {
    if (!canManageCatalog || !tenantId || wf.tenantId !== tenantId) {
      setError('Workflow test execution requires a platform administrator session and the workflow tenant to be selected.');
      return;
    }
    setSelectedWorkflow(wf);
    setTestAttempt(testAttempts.current.get(tenantId) ?? null);
    setTestSource('backend');
    setTestFiles([]); setTestArtifacts('[]');
    const schema = wf.schema as { input_schema?: { properties?: Record<string, { default?: unknown }> } } | undefined;
    const defaults: Record<string, unknown> = {};
    if (schema?.input_schema?.properties) {
      for (const [k, v] of Object.entries(schema.input_schema.properties)) {
        defaults[k] = v.default ?? '';
      }
    }
    setTestInputVariables(defaults);
    setTestVariablesJson(JSON.stringify(defaults, null, 2));
    setTestResult(null);
    setTestModalOpen(true);
  };

  async function dispatchWorkflowTestAttempt(
    originalAttempt: WorkflowTestAttempt,
    requestNo: number,
    alreadyClaimed: boolean,
  ): Promise<void> {
    const tenantScope = originalAttempt.tenantId;
    if (activeTenant.current !== tenantScope) return;
    if (!alreadyClaimed && inFlightTestTenants.current.has(tenantScope)) return;
    const attempt = markAttemptDispatched(originalAttempt);
    storeWorkflowTestAttempt(originalAttempt, attempt);
    if (!alreadyClaimed) {
      inFlightTestTenants.current.add(tenantScope);
      setTestExecuting(true);
    }
    const isCurrentRequest = () => requestNo === testRequest.current && tenantScope === activeTenant.current;
    try {
      const response = await client.postAction('workflow.test', attempt.request as unknown as Record<string, unknown>, {
        idempotencyKey: attempt.idempotencyKey,
      });
      const responseData = response.ok ? response.data as Record<string, unknown> : null;
      const operationId = typeof responseData?.operationId === 'string' ? responseData.operationId : null;
      if (response.ok && operationId) {
        const accepted = acceptAttempt(attempt, operationId);
        storeWorkflowTestAttempt(attempt, accepted);
        if (isCurrentRequest()) {
          const stagesCompleted = Array.isArray(responseData?.stagesCompleted)
            && responseData.stagesCompleted.every((stage): stage is string => typeof stage === 'string')
            ? responseData.stagesCompleted
            : undefined;
          setTestResult({
            status: 'ACCEPTED',
            message: `Workflow '${attempt.request.slug}' was accepted by the backend.`,
            operationId,
            inputEcho: attempt.request.variables,
            executedAt: new Date().toISOString(),
            ...(stagesCompleted ? { stagesCompleted } : {}),
          });
        }
        return;
      }
      const retained = retainAfterFailure(attempt, response.status);
      storeWorkflowTestAttempt(attempt, retained);
      if (isCurrentRequest()) {
        const uncertain = retained !== null;
        setTestResult({
          status: uncertain ? 'UNKNOWN' : 'FAILED',
          message: response.ok
            ? 'The backend accepted a response without an operation ID. The saved request is held for exact reconciliation.'
            : response.problem.title ?? 'The backend could not start this workflow test.',
          errorCode: response.ok ? 'MISSING_OPERATION_ID' : response.problem.code ?? (response.status === 0 ? 'TRANSPORT_ERROR' : `HTTP_${response.status}`),
          httpStatus: response.status,
        });
      }
    } catch (error) {
      const retained = retainAfterFailure(attempt, 0);
      storeWorkflowTestAttempt(attempt, retained);
      if (isCurrentRequest()) {
        const errorCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'REQUEST_EXCEPTION';
        setTestResult({
          status: 'UNKNOWN',
          message: error instanceof Error ? error.message : 'The workflow test request result is unknown. Retry the exact saved request.',
          errorCode,
        });
      }
    } finally {
      inFlightTestTenants.current.delete(tenantScope);
      if (activeTenant.current === tenantScope) setTestExecuting(false);
    }
  }

  const retryWorkflowTestAttempt = async () => {
    if (!testAttempt || testAttempt.tenantId !== tenantId || testAttempt.state === 'ACCEPTED') return;
    const requestNo = ++testRequest.current;
    await dispatchWorkflowTestAttempt(testAttempt, requestNo, false);
  };

  const handleExecuteTest = async () => {
    if (!canManageCatalog || !selectedWorkflow || !tenantId
      || (selectedWorkflow.tenantId !== undefined && selectedWorkflow.tenantId !== tenantId)) return;
    const tenantScope = tenantId;
    const workflow = selectedWorkflow;
    const attemptScope = tenantScope;
    if (testAttempts.current.has(attemptScope)) {
      if (activeTenant.current === tenantScope) setTestResult({
        status: 'UNKNOWN',
        message: 'Resolve the saved request before starting another workflow test. Use the exact retry action below.',
      });
      return;
    }
    if (inFlightTestTenants.current.has(tenantScope)) return;
    inFlightTestTenants.current.add(tenantScope);
    setTestExecuting(true);
    const requestNo = ++testRequest.current;
    const isCurrentRequest = () => requestNo === testRequest.current && tenantScope === activeTenant.current;
    const files = testFiles;
    const variablesJson = testVariablesJson;
    const artifactsJson = testArtifacts;
    const apiKeyId = testApiKeyId;
    let dispatched = false;
    setTestResult(null);
    try {
      if (testSource === 'simulation') {
        if (!isCurrentRequest()) return;
        setTestResult({
          status: 'SIMULATED_SUCCESS',
          dataSource: 'simulation',
          message: `Workflow '${workflow.slug}' was simulated locally; no backend request was sent.`,
          inputEcho: testInputVariables,
          simulatedStages: workflow.stages ?? [],
          executedAt: new Date().toISOString(),
        });
        return;
      }

      if (!apiKeyId) throw new Error('Choose an active API key before starting the backend test.');
      const variables: unknown = JSON.parse(variablesJson);
      if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new Error('Input variables must be a JSON object');
      const parsedArtifacts: unknown = JSON.parse(artifactsJson);
      if (!Array.isArray(parsedArtifacts) || !parsedArtifacts.every((row) => row !== null && typeof row === 'object'
        && !Array.isArray(row) && typeof (row as Record<string, unknown>).artifactId === 'string'
        && typeof (row as Record<string, unknown>).role === 'string')) throw new Error('Existing artifacts must be a JSON array of artifact IDs and roles.');
      if (files.length + parsedArtifacts.length > 20) throw new Error('Choose no more than 20 documents');
      if (files.some(file => file.size > 16 * 1024 * 1024)) throw new Error('Each test document must be at most 16 MiB');
      const uploaded: Array<{ artifactId: string; role: string }> = [];
      for (const [index, file] of files.entries()) {
        if (!isCurrentRequest()) return;
        const cached = uploadedTestFiles.current.get(file, tenantScope, apiKeyId);
        let artifactId: string;
        if (cached) {
          artifactId = cached;
        } else {
          const upload = await client.uploadWorkflowFile(tenantScope, apiKeyId, file);
          if (!upload.ok) throw new Error(upload.problem.title ?? `Upload failed for ${file.name}`);
          artifactId = upload.data.artifactId;
          uploadedTestFiles.current.set(file, tenantScope, apiKeyId, artifactId);
          if (!isCurrentRequest()) return;
        }
        uploaded.push({ artifactId, role: `files-${index + 1}` });
      }
      if (!isCurrentRequest()) return;
      const requestBody: WorkflowTestRequest = {
        tenantId: tenantScope,
        slug: workflow.slug,
        expectedRevision: workflow.revision,
        apiKeyId,
        artifacts: [...uploaded, ...parsedArtifacts as Array<{ artifactId: string; role: string }>],
        variables: variables as Record<string, unknown>,
      };
      const attempt = createImmutableAttempt(tenantScope, globalThis.crypto?.randomUUID?.() ?? `workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`, requestBody);
      storeWorkflowTestAttempt(attempt, attempt);
      dispatched = true;
      await dispatchWorkflowTestAttempt(attempt, requestNo, true);
    } catch (error) {
      if (isCurrentRequest()) {
        const errorCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'REQUEST_EXCEPTION';
        setTestResult({ status: 'FAILED', message: error instanceof Error ? error.message : 'The workflow test request could not be prepared.', errorCode });
      }
    } finally {
      if (!dispatched) {
        inFlightTestTenants.current.delete(tenantScope);
        if (activeTenant.current === tenantScope) setTestExecuting(false);
      }
    }
  };

  return (
    <div className="space-y-6 min-w-0">
      {/* ── Top Header ────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between border-b pb-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-2 bg-primary/10 text-primary rounded-lg">
              <Workflow className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Business Workflows</h1>
              <p className="text-sm text-muted-foreground">
                Provision, import and test multi-stage document processing pipelines (WFA Document Pipelines).
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Badge variant={metadataConfigured === true ? 'info' : 'warning'} className="py-1 px-3">
            Metadata encryption: {metadataConfigured === null ? 'unknown' : metadataConfigured ? 'configured' : 'not configured'}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchWorkflows()}
            disabled={loading}
            className="flex items-center gap-1.5"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setImportSourceText(JSON.stringify(PRESET_SAMPLES[0]?.schema, null, 2));
              setImportError(null);
              setImportModalOpen(true);
            }}
            disabled={!canManageCatalog || !tenantId || actionInProgress !== null}
            title={!canManageCatalog ? 'Requires a platform administrator session.' : !tenantId ? 'Select a tenant first.' : undefined}
            className="flex items-center gap-1.5"
          >
            <Plus className="h-4 w-4" />
            Create / Import Workflow
          </Button>
        </div>
      </div>

      {/* Notifications */}
      {error && (
        <AlertBanner variant="error" title="Error">
          <div className="flex flex-wrap items-center gap-3">
            <span>{error}</span>
            <Button size="sm" variant="outline" disabled={loading} onClick={() => void fetchWorkflows()}>Refresh catalog</Button>
          </div>
        </AlertBanner>
      )}
      {successMsg && (
        <AlertBanner variant="success" title="Success">
          {successMsg}
        </AlertBanner>
      )}

      {!canManageCatalog ? (
        <AlertBanner variant="warning" title="Read-only workflow access">
          Workflow creation, revision publishing, retirement, and backend tests require a platform administrator session under the current Admin BFF policy.
        </AlertBanner>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Business ownership</CardTitle>
          <CardDescription>
            New workflow revisions can be registered to a business version. Leave this unassigned to keep the legacy tenant-wide catalog behavior.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <label className="block w-full max-w-xs space-y-1 text-xs font-medium">
            <span>Business</span>
            <select
              aria-label="Workflow business"
              className="h-9 w-full rounded border bg-background px-3 text-sm"
              value={ownerBusinessId}
              onChange={(event) => setOwnerBusinessId(event.target.value)}
            >
              <option value="">Unassigned (legacy)</option>
              {businesses.map((business) => <option key={business} value={business}>{business}</option>)}
            </select>
          </label>
          {ownerBusinessId ? (
            <label className="block w-full max-w-[12rem] space-y-1 text-xs font-medium">
              <span>Business version</span>
              <select
                aria-label="Workflow business version"
                className="h-9 w-full rounded border bg-background px-3 text-sm"
                value={ownerBusinessVersion}
                onChange={(event) => setOwnerBusinessVersion(event.target.value)}
                disabled={businessVersions.length === 0}
              >
                {businessVersions.length === 0 ? <option value="">No registered versions</option> : null}
                {businessVersions.map((version) => <option key={version} value={version}>{version}</option>)}
              </select>
            </label>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Section 1: Ready-To-Activate Sample Workflow Library ────────────────── */}
      <Card className="border-primary/20 bg-gradient-to-r from-card via-card to-primary/5">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Boxes className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg">Workflow templates</CardTitle>
            </div>
            <Badge variant="info" className="text-xs">
              3 Standardized Scenarios
            </Badge>
          </div>
          <CardDescription>
            Activate a template for the current organization, configure its profile and connector bindings, then test it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {PRESET_SAMPLES.map((preset) => {
              const isProvisioned = workflows.some(
                (w) => w.slug === preset.slug && w.status === 'active'
              );
              const isBusy = actionInProgress === preset.slug;

              return (
                <div
                  key={preset.slug}
                  className="rounded-xl border bg-card p-4 flex flex-col justify-between hover:border-primary/50 transition-all shadow-sm"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-primary uppercase tracking-wider">
                        {preset.badge}
                      </span>
                      {isProvisioned && (
                        <Badge variant="success" className="text-[10px] px-2 py-0.5">
                          Activated (Active)
                        </Badge>
                      )}
                    </div>
                    <h3 className="font-semibold text-base leading-tight">{preset.name}</h3>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {preset.description}
                    </p>

                    {/* Stage flow pills */}
                    <div className="pt-2">
                      <div className="text-[11px] font-medium text-muted-foreground mb-1">Processing stages:</div>
                      <div className="flex flex-wrap items-center gap-1">
                        {preset.schema.nodes.map((node, idx) => (
                          <span key={node.id} className="flex items-center gap-1 text-[11px]">
                            <span className="px-2 py-0.5 rounded bg-muted font-mono font-medium text-foreground">
                              {node.id}
                            </span>
                            {idx < preset.schema.nodes.length - 1 && (
                              <ArrowRight className="h-3 w-3 text-muted-foreground" />
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 mt-2 border-t flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground font-mono">
                      slug: {preset.slug}
                    </span>
                    <Button
                      size="sm"
                      variant={isProvisioned ? 'secondary' : 'primary'}
                      disabled={isBusy || actionInProgress !== null || (!isProvisioned && (!canManageCatalog || !tenantId))}
                      onClick={() => {
                        if (isProvisioned) {
                          const active = workflows.find(workflow => workflow.slug === preset.slug && workflow.status === 'active');
                          if (active) setSelectedWorkflow(active);
                        } else {
                          void handleProvisionPreset(preset);
                        }
                      }}
                      title={isProvisioned ? 'Select the active catalog revision.' : !canManageCatalog ? 'Requires a platform administrator session.' : undefined}
                      className="gap-1.5"
                    >
                      {isBusy ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      ) : isProvisioned ? (
                        <>
                          <Check className="h-3.5 w-3.5" /> View Active Revision
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5 fill-current" /> Activate Now
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── Section 2: Active Workflow Catalog ────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Workflows List (1 col) */}
        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Layers className="h-4 w-4 text-primary" />
                  Workflow List ({filteredWorkflows.length}{catalogSearch ? ` / ${workflows.length}` : ''})
                </CardTitle>
              </div>
              <CardDescription>
                The schemas currently configured for this tenant.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-2">
              <label htmlFor="workflow-catalog-search" className="sr-only">Search workflow catalog</label>
              <input
                id="workflow-catalog-search"
                type="search"
                value={catalogSearch}
                onChange={(event) => setCatalogSearch(event.target.value)}
                placeholder="Search by name or slug"
                className="mb-2 w-full rounded border bg-background px-3 py-2 text-sm"
              />
              {(loading || catalogTenantId !== tenantId) && workflows.length === 0 ? (
                <div className="p-6">
                  <LoadingState title="Loading..." description="Loading the workflow list..." />
                </div>
              ) : catalogLoadError && workflows.length === 0 ? (
                <div className="p-6">
                  <ErrorState title="Workflow catalog unavailable" description="The tenant workflow list could not be loaded. Retry before creating a new schema." onRetry={() => void fetchWorkflows()} />
                </div>
              ) : workflows.length === 0 ? (
                <div className="p-6 text-center">
                  <EmptyState
                    title="No workflows yet"
                    description="Activate a sample workflow above, or load a JSON file, to get started."
                  />
                  <div className="mt-4">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        const first = PRESET_SAMPLES[0];
                        if (first) handleProvisionPreset(first);
                      }}
                      disabled={!canManageCatalog || !tenantId || actionInProgress !== null}
                    >
                      Activate The IDP Pipeline Sample
                    </Button>
                  </div>
                </div>
              ) : filteredWorkflows.length === 0 ? (
                <div className="p-6">
                  <EmptyState title="No matching workflows" description="Change the search text or clear it to see the tenant catalog." actionText="Clear search" onAction={() => setCatalogSearch('')} />
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredWorkflows.map((wf) => {
                    const isSelected = selectedWorkflow?.slug === wf.slug && selectedWorkflow?.revision === wf.revision;
                    return (
                      <button
                        key={`${wf.slug}-${wf.revision}`}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedWorkflow(wf)}
                        className={`w-full text-left p-3 rounded-lg border transition-all flex flex-col gap-1.5 ${
                          isSelected
                            ? 'bg-primary/10 border-primary shadow-sm font-medium'
                            : 'hover:bg-muted border-transparent hover:border-border'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-sm truncate max-w-[190px]">
                            {wf.name || wf.slug}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                              v{wf.revision}
                            </span>
                            <Badge
                              variant={wf.status === 'active' ? 'success' : 'neutral'}
                              className="text-[10px] px-1.5 py-0"
                            >
                              {wf.status}
                            </Badge>
                          </div>
                        </div>

                        <div className="text-xs text-muted-foreground flex items-center justify-between font-mono">
                          <span>{wf.slug}</span>
                          {/* AWEB-WORKFLOW-STAGE-COUNT-HONESTY: report what the wire says.
                              Both fields are optional, so an absent stage list is 0 stages -
                              never a fabricated 1, and nodesCount 0 stays 0 because ?? only
                              falls through on null/undefined. */}
                          <span>{wf.nodesCount ?? wf.stages?.length ?? 0} stages</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Workflow Detail & Interactive Graph (2 cols) */}
        <div className="lg:col-span-2 space-y-4">
          {selectedWorkflow ? (
            <Card>
              <CardHeader className="pb-3 border-b">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-xl">
                        {selectedWorkflow.name || selectedWorkflow.slug}
                      </CardTitle>
                      <Badge variant="neutral" className="font-mono text-xs">
                        Revision {selectedWorkflow.revision}
                      </Badge>
                      <Badge
                        variant={selectedWorkflow.status === 'active' ? 'success' : 'neutral'}
                      >
                        {selectedWorkflow.status.toUpperCase()}
                      </Badge>
                    </div>
                    <CardDescription className="mt-1">
                      {selectedWorkflow.description || 'Automated processing pipeline in the catalog.'}
                    </CardDescription>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Business: {selectedWorkflow.businessId
                        ? `${selectedWorkflow.businessId}@${selectedWorkflow.businessVersion ?? 'unknown'}`
                        : 'Unassigned (legacy)' }
                    </p>
                    <div className="flex flex-wrap gap-3 mt-2 text-xs"><Link className="underline" to={`/profiles?businessId=${encodeURIComponent(selectedWorkflow.businessId ?? 'document-core')}${selectedWorkflow.businessVersion ? `&businessVersion=${encodeURIComponent(selectedWorkflow.businessVersion)}` : ''}`}>Configure workflow profile</Link><Link className="underline" to='/connectors'>Inspect connector revisions and health</Link></div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!canManageCatalog || !tenantId || selectedWorkflow.status !== 'active' || selectedWorkflow.tenantId !== tenantId || actionInProgress !== null}
                      onClick={() => openTestModal(selectedWorkflow)}
                      className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      <Play className="h-4 w-4 fill-current" /> Test Run
                    </Button>
                    {selectedWorkflow.status === 'active' && canManageCatalog && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!selectedWorkflow.schema || typeof selectedWorkflow.schema !== 'object' || actionInProgress !== null}
                        onClick={() => openRevisionEditor(selectedWorkflow)}
                        className="gap-1.5"
                      >
                        Edit active revision
                      </Button>
                    )}
                    {selectedWorkflow.status === 'active' && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setRetireTarget(selectedWorkflow)}
                        disabled={!canManageCatalog || actionInProgress !== null}
                        title={!canManageCatalog ? 'Requires a platform administrator session.' : undefined}
                        className="gap-1.5"
                      >
                        <Trash2 className="h-4 w-4" /> Retire
                      </Button>
                    )}
                  </div>
                </div>

                {/* Metadata details strip */}
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs bg-muted/50 p-2.5 rounded-lg font-mono">
                  <div>
                    <span className="text-muted-foreground block text-[10px] uppercase font-sans">
                      Slug
                    </span>
                    <span className="font-semibold text-foreground">{selectedWorkflow.slug}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[10px] uppercase font-sans">
                      SHA-256 Digest
                    </span>
                    <div className="flex items-center gap-1">
                      <span className="truncate max-w-[130px]">{selectedWorkflow.digest}</span>
                      <button
                        onClick={() => handleCopyDigest(selectedWorkflow.digest)}
                        className="hover:text-primary"
                        title="Copy digest"
                      >
                        {copiedDigest === selectedWorkflow.digest ? (
                          <Check className="h-3 w-3 text-emerald-500" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[10px] uppercase font-sans">
                      Created
                    </span>
                    <span className="text-foreground">
                      {new Date(selectedWorkflow.createdAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-6 pt-6">
                {/* ── Visual Node Flow Diagram ─────────────────────────── */}
                <div>
                  <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
                    <GitBranch className="h-4 w-4 text-primary" />
                    Processing Flow Diagram (Workflow Graph)
                  </h3>

                  {/* Visual Node Flow Horizontal Timeline */}
                  <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3 overflow-x-auto p-4 bg-muted/20 border rounded-xl">
                    {/* Start Node */}
                    <div className="flex flex-col items-center justify-center p-3 rounded-lg bg-background border border-dashed text-xs text-center min-w-[100px]">
                      <span className="font-semibold text-muted-foreground">Input Document</span>
                      <span className="text-[10px] text-muted-foreground">Payload / Upload</span>
                    </div>

                    <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0 hidden md:block" />

                    {/* Dynamic Stages from Schema */}
                    {selectedWorkflow.schema &&
                    typeof selectedWorkflow.schema === 'object' &&
                    Array.isArray((selectedWorkflow.schema as { nodes?: Array<{ id: string; type: string; description?: string; connector?: string }> }).nodes) ? (
                      (selectedWorkflow.schema as { nodes: Array<{ id: string; type: string; description?: string; connector?: string }> }).nodes.map(
                        (node, idx, arr) => (
                          <div key={node.id} className="flex items-center gap-3">
                            <div className="p-3.5 rounded-xl border bg-card shadow-sm hover:border-primary/60 transition-all min-w-[190px] flex-1">
                              <div className="flex items-center justify-between gap-2 mb-1.5">
                                <span className="font-mono text-xs font-bold text-primary">
                                  #{idx + 1} {node.id}
                                </span>
                                <Badge variant="neutral" className="text-[10px] px-1.5 py-0">
                                  {node.type}
                                </Badge>
                              </div>
                              <div className="text-xs font-medium text-foreground line-clamp-1">
                                {node.description || 'Data processing'}
                              </div>
                              {node.connector && (
                                <div className="mt-2 pt-1.5 border-t flex items-center justify-between text-[11px] text-muted-foreground">
                                  <span>Connector:</span>
                                  <span className="font-mono font-medium text-foreground">
                                    {node.connector}
                                  </span>
                                </div>
                              )}
                            </div>
                            {idx < arr.length - 1 && (
                              <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0 hidden md:block" />
                            )}
                          </div>
                        )
                      )
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        No node configuration was found in the schema.
                      </div>
                    )}

                    <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0 hidden md:block" />

                    {/* Final Output Node */}
                    <div className="flex flex-col items-center justify-center p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-center min-w-[110px]">
                      <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                        Final Result
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        Structured Output
                      </span>
                    </div>
                  </div>
                </div>

                {/* ── Connector Slot Mapping ─────────────────────────── */}
                {selectedWorkflow.connectorSlotMap &&
                  Object.keys(selectedWorkflow.connectorSlotMap).length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold flex items-center gap-2 mb-2">
                        <Boxes className="h-4 w-4 text-primary" />
                        Connector Slot Mapping
                      </h3>
                      <p className="text-xs mb-2">These are schema slot assignments. The selected API key's profile must pin compatible connector revisions; admission verifies those pins when a test starts.</p>
                      <div className="max-h-[min(65dvh,40rem)] overflow-auto rounded-lg border text-xs" role="region" aria-label={`Connector slot mappings for workflow ${selectedWorkflow.name}`} tabIndex={0}>
                        <table className="w-full">
                          <thead className="sticky top-0 z-10 border-b bg-muted text-left text-muted-foreground">
                            <tr>
                              <th className="p-2.5 font-medium">Connector Name</th>
                              <th className="p-2.5 font-medium">Internal Slot Binding</th>
                              <th className="p-2.5 font-medium">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y font-mono">
                            {Object.entries(selectedWorkflow.connectorSlotMap).map(
                              ([connector, slot]) => (
                                <tr key={connector} className="hover:bg-muted/30">
                                  <td className="p-2.5 font-semibold text-foreground">
                                    {connector}
                                  </td>
                                  <td className="p-2.5 text-primary">{slot}</td>
                                  <td className="p-2.5">
                                    <Badge variant="neutral" className="text-[10px] px-1.5">
                                      Schema slot assigned
                                    </Badge>
                                  </td>
                                </tr>
                              )
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                {/* ── Raw Schema JSON Preview ─────────────────────────── */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <Code2 className="h-4 w-4 text-primary" />
                      JSON Schema Definition Details
                    </h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void navigator.clipboard.writeText(
                          JSON.stringify(selectedWorkflow.schema, null, 2)
                        )
                      }
                      className="h-7 text-xs gap-1"
                    >
                      <Copy className="h-3 w-3" /> Copy JSON
                    </Button>
                  </div>
                  <pre className="p-4 rounded-xl bg-muted/60 border text-xs font-mono overflow-x-auto max-h-[280px]">
                    {JSON.stringify(selectedWorkflow.schema, null, 2)}
                  </pre>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-12 text-center text-muted-foreground">
                <HelpCircle className="h-8 w-8 mx-auto mb-2 text-muted-foreground/60" />
                <p>Select a workflow from the list on the left, or activate a sample workflow, to view its configuration.</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* ── Modal 1: Import / Create A New Workflow Schema ────────────────── */}
      <Modal
        open={importModalOpen}
        onOpenChange={(open) => { if (!actionInProgress && !importPreviewBusy) setImportModalOpen(open); }}
        title="Preview and create a workflow schema"
        description="Import JSON or legacy XML through the bounded server decoder. Review the validated schema and egress origins before creating an immutable revision."
        maxWidth="max-w-2xl"
        showCloseButton={!actionInProgress && !importPreviewBusy}
      >
        <div className="space-y-4">
          {importError && (
            <AlertBanner variant="error" title="Schema Error">
              {importError}
            </AlertBanner>
          )}

          <label className="block space-y-1 text-sm">
            <span>Source format</span>
            <select
              aria-label="Workflow import format"
              className="w-full rounded border bg-background p-2"
              value={importFormat}
              disabled={actionInProgress !== null || importPreviewBusy}
              onChange={(event) => {
                setImportFormat(event.target.value as 'json' | 'xml');
                setImportPreview(null);
                setImportPreviewSource(null);
                setApprovedStaticOrigins([]);
                setDynamicOriginDrafts({});
                setImportError(null);
              }}
            >
              <option value="json">JSON schema</option>
              <option value="xml">Legacy Workflow Builder XML</option>
            </select>
          </label>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="workflow-import-source" className="text-xs font-medium">{importFormat === 'xml' ? 'Legacy XML source:' : 'JSON schema source:'}</label>
              {importFormat === 'json' ? <div className="flex flex-wrap items-center gap-1.5">
                {PRESET_SAMPLES.map((p) => (
                  <Button
                    key={p.slug}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 text-[11px] px-2"
                    onClick={() => { setImportSourceText(JSON.stringify(p.schema, null, 2)); setImportPreview(null); setImportPreviewSource(null); setApprovedStaticOrigins([]); }}
                  >
                    Use template {p.slug}
                  </Button>
                ))}
              </div> : null}
            </div>
            <textarea
              id="workflow-import-source"
              rows={14}
              value={importSourceText}
              onChange={(e) => { setImportSourceText(e.target.value); setImportPreview(null); setImportPreviewSource(null); setApprovedStaticOrigins([]); setDynamicOriginDrafts({}); setImportError(null); }}
              aria-invalid={importError !== null}
              aria-describedby="workflow-import-help"
              placeholder={importFormat === 'xml' ? '<workflow slug="…">…</workflow>' : 'Paste the JSON schema here...'}
              className="w-full font-mono text-xs p-3 rounded-lg border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <p id="workflow-import-help" className="mt-2 text-xs text-muted-foreground">
              The parser rejects DTDs, declared entities, unsupported XML nodes, malformed bindings, and input over 512 KiB. New slugs are created with a revision check; edit an active workflow from the catalog.
            </p>
          </div>

          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={() => void handleImportPreview()} disabled={importPreviewBusy || actionInProgress !== null || !canManageCatalog || !tenantId || !importSourceText.trim()}>
              {importPreviewBusy ? 'Validating…' : 'Validate and preview'}
            </Button>
          </div>

          {importPreviewCurrent && importPreview ? (
            <section aria-labelledby="workflow-import-preview-title" className="space-y-3 rounded border p-3">
              <div>
                <h3 id="workflow-import-preview-title" className="font-semibold">Server validated preview</h3>
                <p className="text-xs text-muted-foreground">{importPreview.schema.name as string} · <code>{importPreview.schema.slug as string}</code> · {Array.isArray(importPreview.schema.nodes) ? importPreview.schema.nodes.length : 0} top-level nodes · {importPreview.connectorNames.length} Connector names</p>
                <p className="break-all font-mono text-[11px]">Source digest: {importPreview.sourceDigest}</p>
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Connector mapping and node overrides</h4>
                {importPreview.connectorNames.length ? <ul className="space-y-1 text-xs">{importPreview.connectorNames.map(name => <li key={name}>Workflow Connector <code>{name}</code> maps to a stable legacy slot during provisioning. Confirm its Profile revision bindings before running.</li>)}</ul> : <p className="text-xs text-muted-foreground">This workflow has no Connector nodes.</p>}
                <details>
                  <summary className="cursor-pointer text-xs underline">Review complete normalized schema and node overrides</summary>
                  <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted/40 p-2 text-[11px]">{JSON.stringify(importPreview.schema, null, 2)}</pre>
                </details>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Egress approval</legend>
                {previewStaticOrigins.length ? previewStaticOrigins.map(origin => (
                  <label key={origin} className="flex items-start gap-2 text-xs">
                    <input type="checkbox" checked={approvedStaticOrigins.includes(origin)} onChange={event => setApprovedStaticOrigins(current => event.target.checked ? [...new Set([...current, origin])] : current.filter(item => item !== origin))} />
                    <span>Approve static origin <code className="break-all">{origin}</code></span>
                  </label>
                )) : null}
                {importPreview.egress.filter(item => item.dynamic).map(item => (
                  <label key={`${item.kind}:${item.nodeId}`} className="block space-y-1 text-xs">
                    <span>Dynamic URL origins for node <code>{item.nodeId}</code> ({item.kind}); one exact HTTPS origin per line</span>
                    <textarea aria-label={`Dynamic egress origins for ${item.nodeId}`} rows={2} className="w-full rounded border bg-background p-2 font-mono" value={dynamicOriginDrafts[item.nodeId] ?? ''} onChange={event => setDynamicOriginDrafts(current => ({ ...current, [item.nodeId]: event.target.value }))} placeholder="https://files.example.test" />
                  </label>
                ))}
                {importPreview.egress.length === 0 ? <p className="text-xs text-muted-foreground">No callback or remote file-download egress was found.</p> : null}
                <p className="text-xs text-muted-foreground">Approved origins are pinned to this workflow revision and checked again by runtime policy. Dynamic URLs still must pass the runtime SSRF and tenant policy checks.</p>
              </fieldset>
            </section>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-2 border-t">
            <Button
              type="button"
              variant="outline"
              disabled={actionInProgress !== null || importPreviewBusy}
              onClick={() => setImportModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => void handleImportSubmit()}
              disabled={actionInProgress !== null || importPreviewBusy || !canManageCatalog || !tenantId || !importPreviewCurrent || !importEgressApproved}
              className="gap-1.5"
            >
              {actionInProgress === 'custom-import' ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Confirm Activation
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={revisionEditorOpen}
        onOpenChange={(open) => { if (open) setRevisionEditorOpen(true); else requestCloseRevisionEditor(); }}
        title={revisionTarget ? `Edit ${revisionTarget.name} (revision ${revisionTarget.revision})` : 'Edit workflow revision'}
        description="Edit the active schema and publish a new immutable revision. The server validates the full schema and compares expectedRevision before writing."
        maxWidth="max-w-4xl"
        showCloseButton={!actionInProgress}
      >
        {revisionTarget ? (
          <div className="space-y-4">
            {revisionError ? (
              <AlertBanner variant={revisionConflict ? 'warning' : 'error'} title={revisionConflict ? 'Revision changed before publish' : 'Revision status'}>
                <div className="space-y-2">
                  <p role={revisionConflict ? 'alert' : 'status'}>{revisionError}</p>
                  {revisionConflict ? <Button size="sm" variant="outline" disabled={revisionBaseLoading || actionInProgress !== null} onClick={() => void refreshRevisionBase()}>{revisionBaseLoading ? 'Loading active revision…' : 'Load active revision and compare draft'}</Button> : null}
                </div>
              </AlertBanner>
            ) : null}
            <div className="rounded border bg-muted/30 p-3 text-xs">
              Active revision <strong>{revisionTarget.revision}</strong> is the compare-and-swap base. Saving creates revision <strong>{revisionTarget.revision + 1}</strong> only if that base is still active.
            </div>
            {revisionSchema ? (
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block space-y-1 text-sm">
                  <span>Workflow name</span>
                  <input className="w-full rounded border bg-background p-2" value={typeof revisionSchema.name === 'string' ? revisionSchema.name : ''} onChange={event => updateRevisionField('name', event.target.value)} />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Description</span>
                  <textarea className="w-full rounded border bg-background p-2" rows={2} value={typeof revisionSchema.description === 'string' ? revisionSchema.description : ''} onChange={event => updateRevisionField('description', event.target.value)} />
                </label>
              </div>
            ) : null}
            <section aria-labelledby="workflow-connectors-title" className="space-y-2 rounded border p-3">
              <h3 id="workflow-connectors-title" className="text-sm font-semibold">Connector references</h3>
              <p className="text-xs text-muted-foreground">Edit the connector name referenced by each schema node. Slot mappings are derived and preserved by the backend for each connector name; the profile must pin compatible revisions.</p>
              {revisionConnectors.length ? revisionConnectors.map(reference => {
                const nodePath = reference.path.slice(0, -1);
                const node = connectorNodeAtPath(revisionSchema, nodePath) ?? {};
                const override = node.overrideConnector !== null && typeof node.overrideConnector === 'object' && !Array.isArray(node.overrideConnector)
                  ? node.overrideConnector as Record<string, unknown>
                  : {};
                const staticRows = parseWorkflowOverrideRows('staticFormFields', override.staticFormFields);
                const headerRows = parseWorkflowOverrideRows('extraHeaders', override.extraHeaders);
                return (
                  <div key={`${reference.nodeId}:${reference.path.join('.')}`} className="space-y-2 rounded border p-2">
                    <label className="grid gap-1 text-xs sm:grid-cols-[minmax(8rem,0.7fr)_minmax(12rem,1fr)] sm:items-center">
                      <span>Node <code>{reference.nodeId}</code> Connector</span>
                      <input
                        aria-label={`Connector for node ${reference.nodeId}`}
                        className="rounded border bg-background p-2 font-mono"
                        value={reference.connector}
                        disabled={!revisionSchema}
                        onChange={event => {
                          try {
                            setRevisionError(null);
                            setRevisionDraft(JSON.stringify(updateConnectorReference(revisionSchema, reference.path, event.target.value), null, 2));
                          }
                          catch (error) { setRevisionError(error instanceof Error ? error.message : 'Could not update this connector reference.'); }
                        }}
                      />
                    </label>
                    <label className="block space-y-1 text-xs">
                      <span>Prompt override for node <code>{reference.nodeId}</code></span>
                      <textarea
                        aria-label={`Prompt override for node ${reference.nodeId}`}
                        rows={3}
                        className="w-full rounded border bg-background p-2"
                        value={typeof override.prompt === 'string' ? override.prompt : ''}
                        onChange={event => {
                          try {
                            setRevisionError(null);
                            setRevisionDraft(JSON.stringify(updateConnectorNodeOverride(revisionSchema, nodePath, 'prompt', event.target.value || undefined), null, 2));
                          }
                          catch (error) { setRevisionError(error instanceof Error ? error.message : 'Could not update this node prompt.'); }
                        }}
                      />
                    </label>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="block space-y-1 text-xs">
                        <span>Timeout seconds (optional)</span>
                        <input
                          type="number"
                          min={1}
                          max={3600}
                          aria-label={`Timeout seconds for node ${reference.nodeId}`}
                          className="w-full rounded border bg-background p-2"
                          value={typeof override.timeoutSec === 'number' ? override.timeoutSec : ''}
                          onChange={event => {
                            const raw = event.target.value;
                            const value = raw === '' ? undefined : Number(raw);
                            if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 3600)) return;
                            try {
                              setRevisionError(null);
                              setRevisionDraft(JSON.stringify(updateConnectorNodeOverride(revisionSchema, nodePath, 'timeoutSec', value), null, 2));
                            }
                            catch (error) { setRevisionError(error instanceof Error ? error.message : 'Could not update this node timeout.'); }
                          }}
                        />
                      </label>
                      <label className="block space-y-1 text-xs">
                        <span>Response content path (optional)</span>
                        <input
                          aria-label={`Response content path for node ${reference.nodeId}`}
                          className="w-full rounded border bg-background p-2 font-mono"
                          value={typeof override.responseContentPath === 'string' ? override.responseContentPath : ''}
                          onChange={event => {
                            try {
                              setRevisionError(null);
                              setRevisionDraft(JSON.stringify(updateConnectorNodeOverride(revisionSchema, nodePath, 'responseContentPath', event.target.value || undefined), null, 2));
                            }
                            catch (error) { setRevisionError(error instanceof Error ? error.message : 'Could not update this response path.'); }
                          }}
                        />
                      </label>
                    </div>
                    <section aria-label={`Static form fields for node ${reference.nodeId}`} className="space-y-2 rounded border border-dashed p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-xs font-semibold">Static form fields</h4><p className="text-[11px] text-muted-foreground">Bounded values merged into this node’s connector form.</p></div><Button size="sm" variant="outline" disabled={!staticRows.ok || staticRows.rows.length >= 32} onClick={() => {
                        if (!staticRows.ok) return;
                        let next = 1;
                        while (staticRows.rows.some(row => row.name.toLowerCase() === `field${next}`.toLowerCase())) next += 1;
                        updateGuidedOverrideRows(nodePath, 'staticFormFields', [...staticRows.rows, { name: `field${next}`, value: '' }]);
                      }}>Add static field</Button></div>
                      {staticRows.ok ? staticRows.rows.length > 0 ? <div className="space-y-2">{staticRows.rows.map((rawRow, rowIndex) => {
                        const row = rawRow as WorkflowStaticFormField;
                        const replaceRow = (nextRow: WorkflowStaticFormField | null) => {
                          const rows = [...staticRows.rows] as WorkflowStaticFormField[];
                          if (nextRow) rows[rowIndex] = nextRow;
                          else rows.splice(rowIndex, 1);
                          updateGuidedOverrideRows(nodePath, 'staticFormFields', rows);
                        };
                        return <div key={`${reference.nodeId}-static-${rowIndex}`} className="grid gap-2 sm:grid-cols-[minmax(6rem,0.7fr)_minmax(8rem,1fr)_auto] sm:items-end">
                          <label className="block space-y-1 text-[11px]"><span>Field name</span><input aria-label={`Static field name ${rowIndex + 1} for node ${reference.nodeId}`} maxLength={64} className="w-full rounded border bg-background p-2 text-xs" value={row.name} onChange={event => replaceRow({ ...row, name: event.target.value })} /></label>
                          <label className="block space-y-1 text-[11px]"><span>Static value</span>{typeof row.value === 'boolean'
                            ? <select aria-label={`Static field value ${rowIndex + 1} for node ${reference.nodeId}`} className="w-full rounded border bg-background p-2 text-xs" value={String(row.value)} onChange={event => replaceRow({ ...row, value: event.target.value === 'true' })}><option value="true">true</option><option value="false">false</option></select>
                            : typeof row.value === 'number'
                              ? <input aria-label={`Static field value ${rowIndex + 1} for node ${reference.nodeId}`} type="number" className="w-full rounded border bg-background p-2 text-xs" value={String(row.value)} onChange={event => { const value = Number(event.target.value); if (event.target.value !== '' && Number.isFinite(value)) replaceRow({ ...row, value }); }} />
                              : <input aria-label={`Static field value ${rowIndex + 1} for node ${reference.nodeId}`} maxLength={512} className="w-full rounded border bg-background p-2 text-xs" value={row.value} onChange={event => replaceRow({ ...row, value: event.target.value })} />}</label>
                          <Button size="sm" variant="ghost" aria-label={`Remove static field ${row.name || rowIndex + 1} from node ${reference.nodeId}`} onClick={() => replaceRow(null)}>Remove</Button>
                        </div>;
                      })}</div> : <p className="text-[11px] text-muted-foreground">No static form fields are set for this node.</p> : <p role="alert" className="text-[11px] text-red-700">{staticRows.message} The imported value remains in Advanced JSON until corrected.</p>}
                    </section>
                    <section aria-label={`Extra headers for node ${reference.nodeId}`} className="space-y-2 rounded border border-dashed p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-xs font-semibold">Extra headers</h4><p className="text-[11px] text-muted-foreground">Bounded printable headers; server validation remains authoritative.</p></div><Button size="sm" variant="outline" disabled={!headerRows.ok || headerRows.rows.length >= 16} onClick={() => {
                        if (!headerRows.ok) return;
                        let next = 1;
                        while (headerRows.rows.some(row => row.name.toLowerCase() === `x-header-${next}`.toLowerCase())) next += 1;
                        updateGuidedOverrideRows(nodePath, 'extraHeaders', [...headerRows.rows, { name: `X-Header-${next}`, value: '' }]);
                      }}>Add header</Button></div>
                      {headerRows.ok ? headerRows.rows.length > 0 ? <div className="space-y-2">{headerRows.rows.map((rawRow, rowIndex) => {
                        const row = rawRow as WorkflowExtraHeader;
                        const replaceRow = (nextRow: WorkflowExtraHeader | null) => {
                          const rows = [...headerRows.rows] as WorkflowExtraHeader[];
                          if (nextRow) rows[rowIndex] = nextRow;
                          else rows.splice(rowIndex, 1);
                          updateGuidedOverrideRows(nodePath, 'extraHeaders', rows);
                        };
                        return <div key={`${reference.nodeId}-header-${rowIndex}`} className="grid gap-2 sm:grid-cols-[minmax(6rem,0.7fr)_minmax(8rem,1fr)_auto] sm:items-end">
                          <label className="block space-y-1 text-[11px]"><span>Header name</span><input aria-label={`Header name ${rowIndex + 1} for node ${reference.nodeId}`} maxLength={64} className="w-full rounded border bg-background p-2 text-xs" value={row.name} onChange={event => replaceRow({ ...row, name: event.target.value })} /></label>
                          <label className="block space-y-1 text-[11px]"><span>Header value</span><input aria-label={`Header value ${rowIndex + 1} for node ${reference.nodeId}`} maxLength={256} className="w-full rounded border bg-background p-2 text-xs" value={row.value} onChange={event => replaceRow({ ...row, value: event.target.value })} /></label>
                          <Button size="sm" variant="ghost" aria-label={`Remove header ${row.name || rowIndex + 1} from node ${reference.nodeId}`} onClick={() => replaceRow(null)}>Remove</Button>
                        </div>;
                      })}</div> : <p className="text-[11px] text-muted-foreground">No extra headers are set for this node.</p> : <p role="alert" className="text-[11px] text-red-700">{headerRows.message} The imported value remains in Advanced JSON until corrected.</p>}
                    </section>
                  </div>
                );
              }) : <p className="text-xs text-muted-foreground">No connector nodes were found in this valid schema. Advanced JSON remains available below.</p>}
            </section>
            <div>
              <label htmlFor="workflow-revision-json" className="text-sm font-medium">Advanced JSON schema</label>
              <p className="mb-2 text-xs text-muted-foreground">Use JSON for fields outside the guided name, description, and connector controls. The workflow slug cannot be changed here.</p>
              <textarea
                id="workflow-revision-json"
                rows={14}
                value={revisionDraft}
                onChange={event => { setRevisionDraft(event.target.value); setRevisionError(null); }}
                aria-invalid={!revisionCheck.ok}
                aria-describedby="workflow-revision-validation"
                className="w-full rounded border bg-background p-3 font-mono text-xs"
              />
              <p id="workflow-revision-validation" role={revisionCheck.ok ? 'status' : 'alert'} className={`mt-1 text-xs ${revisionCheck.ok ? 'text-emerald-700' : 'text-red-700'}`}>
                {revisionCheck.ok ? `Local structure checks passed for slug "${revisionTarget.slug}". Full contract validation runs on the server.` : revisionCheck.message}
              </p>
            </div>
            <section aria-labelledby="workflow-revision-diff-title" className="space-y-2">
              <h3 id="workflow-revision-diff-title" className="text-sm font-semibold">Schema diff</h3>
              <ul className="max-h-56 overflow-auto rounded border bg-muted/30 p-3 font-mono text-[11px]" aria-label="Workflow schema diff">
                {revisionDiff.map((line, index) => <li key={`${line.kind}:${index}`} className={line.kind === 'added' ? 'text-emerald-700' : line.kind === 'removed' ? 'text-red-700' : 'text-muted-foreground'}><span aria-hidden="true">{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}</span>{line.text || ' '}</li>)}
              </ul>
            </section>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="outline" disabled={actionInProgress !== null} onClick={requestCloseRevisionEditor}>Close</Button>
              <Button variant="primary" disabled={!canManageCatalog || revisionConflict || !revisionCheck.ok || revisionDraft === revisionOriginal || actionInProgress !== null} onClick={() => void saveRevision()}>
                {actionInProgress === `revision:${revisionTarget.slug}` ? 'Publishing…' : 'Validate and publish revision'}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={discardRevisionOpen}
        onOpenChange={open => { if (!open && !actionInProgress) setDiscardRevisionOpen(false); }}
        title="Discard this workflow draft?"
        description="The editor contains changes that have not been published. Discarding removes this local draft."
        confirmText="Discard draft"
        cancelText="Keep editing"
        variant="destructive"
        onConfirm={discardRevisionDraft}
      />
      <ConfirmDialog
        open={retireTarget !== null}
        onOpenChange={open => { if (!open && !actionInProgress) setRetireTarget(null); }}
        title={retireTarget ? `Retire ${retireTarget.name || retireTarget.slug}?` : 'Retire workflow?'}
        description={retireTarget ? `This retires active revision ${retireTarget.revision} of "${retireTarget.slug}". Existing immutable revisions remain in the catalog. The server checks expectedRevision before retirement.` : 'This retires the active workflow revision.'}
        confirmText="Retire revision"
        cancelText="Keep active"
        variant="destructive"
        isLoading={actionInProgress === retireTarget?.slug}
        onConfirm={() => { if (retireTarget) void handleRetireWorkflow(retireTarget); }}
      />

      {/* ── Modal 2: Workflow Test Run Console ─────────────── */}
      <Modal
        open={testModalOpen}
        onOpenChange={open => { if (open || !testExecuting) setTestModalOpen(open); }}
        title={`Workflow Test Run: ${selectedWorkflow?.name || selectedWorkflow?.slug}`}
        description="Choose a data source: Backend sends a request to Orchestrator; local simulation sends no request."
        maxWidth="max-w-2xl"
        showCloseButton={!testExecuting}
      >
        <div className="space-y-4">
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium">Test data source</span>
              <select
                aria-label="Workflow test data source"
                className="w-full rounded border bg-background p-2 text-xs text-foreground"
                value={testSource}
                onChange={(event) => setTestSource(event.target.value as WorkflowTestSource)}
              >
                <option value="backend">Orchestrator backend</option>
                <option value="simulation">Local simulation (no backend request)</option>
              </select>
            </label>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground">
              Input Variables
            </h4>

            {selectedWorkflow?.schema &&
            typeof selectedWorkflow.schema === 'object' &&
            (selectedWorkflow.schema as { input_schema?: { properties?: Record<string, { label?: string; description?: string; default?: unknown }> } }).input_schema?.properties ? (
              <div className="space-y-3">
                {Object.entries(
                  (selectedWorkflow.schema as { input_schema: { properties: Record<string, { label?: string; description?: string; default?: unknown }> } }).input_schema.properties
                ).map(([key, prop]) => (
                  <div key={key} className="space-y-1">
                    <label className="text-xs font-medium flex items-center justify-between">
                      <span>{prop.label || key}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{key}</span>
                    </label>
                    <input
                      type="text"
                      value={String(testInputVariables[key] ?? '')}
                      onChange={(e) => {
                        const next = { ...testInputVariables, [key]: e.target.value };
                        setTestInputVariables(next); setTestVariablesJson(JSON.stringify(next, null, 2));
                      }}
                      className="w-full text-xs p-2 rounded border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    {prop.description && (
                      <p className="text-[11px] text-muted-foreground">{prop.description}</p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground p-3 border rounded bg-muted/30">
                This workflow does not require any mandatory input parameters.
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" size="sm" disabled={testExecuting} onClick={() => setTestModalOpen(false)}>
              Close
            </Button>
            {testAttempt && testAttempt.state !== 'ACCEPTED' ? <Button variant="outline" size="sm" disabled={testExecuting || testAttempt.tenantId !== tenantId} onClick={() => void retryWorkflowTestAttempt()}>
              Retry exact saved request
            </Button> : null}
            <Button
              size="sm"
              variant="primary"
              onClick={handleExecuteTest}
              disabled={testExecuting || Boolean(testAttempt) || (testSource === 'backend' && !testApiKeyId)}
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {testExecuting ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4 fill-current" />
              )}
              {testSource === 'simulation' ? 'Run Local Simulation' : 'Start Test Execution'}
            </Button>
          </div>

          {testAttempt?.state === 'UNCERTAIN' || testAttempt?.state === 'SENDING' ? <AlertBanner variant="warning" title="Workflow request needs resolution">The saved request is for tenant <code>{testAttempt.tenantId}</code>, workflow <code>{testAttempt.request.slug}@{testAttempt.request.expectedRevision}</code>. Replay uses the same artifact IDs, variables and key; it does not upload files again.</AlertBanner> : null}
          {testAttempt?.state === 'ACCEPTED' && testAttempt.operationId ? <AlertBanner variant="info" title="Workflow operation already accepted">Operation <code>{testAttempt.operationId}</code> is being tracked. Refresh operation status or wait for a terminal result before starting another test.</AlertBanner> : null}

          {testSource === 'backend' && <div className="space-y-3">
            <label className="block text-sm">Input variables (JSON; preserve numbers, booleans and arrays)
              <textarea className="block border rounded p-2 w-full min-h-24" value={testVariablesJson} onChange={e => setTestVariablesJson(e.target.value)} />
            </label>
            <label className="block text-sm">Active API key ID (uses its normal profile and admission policy)
              <select className="block border rounded p-2 w-full" value={testApiKeyId} onChange={e => setTestApiKeyId(e.target.value)}><option value="">Choose an active API key</option>{testKeys.map(key => <option key={key.id} value={key.id}>{key.name ?? key.prefix} · {key.maskedHint}</option>)}</select>
            </label>
            <label className="block text-sm">Test documents
              <input type="file" multiple className="block border rounded p-2 w-full" onChange={e => setTestFiles(Array.from(e.target.files ?? []))} disabled={testExecuting} />
            </label>
            <p className="text-xs">{testFiles.length ? `${testFiles.length} file(s) selected; uploaded with the selected key's ownership before execution.` : 'Choose documents required by this workflow (maximum 20 files, 16 MiB each).'}</p>
            <details><summary className="text-xs cursor-pointer">Advanced: reuse already uploaded artifacts</summary>
              <label className="block text-sm">Artifact references (JSON array of artifactId and role)<textarea className="block border rounded p-2 w-full" value={testArtifacts} onChange={e => setTestArtifacts(e.target.value)} /></label>
            </details>
            <p className="text-xs">Tests execute real connector calls and may incur usage. Artifact ownership and connector pins are checked by normal admission.</p>
            <p className="text-xs">Readiness: schema revision {selectedWorkflow?.revision ?? 'unknown'} · {testApiKeyId ? 'API key selected' : 'select an API key'} · metadata encryption {metadataConfigured === null ? 'unknown' : metadataConfigured ? 'configured' : 'unavailable'}. Provider connectivity and profile pin compatibility are verified separately.</p>
          </div>}
          {/* Test Execution Output */}
          {testResult && (
            <div
              aria-live="polite"
              className="mt-4 p-4 rounded-xl border bg-muted/40 space-y-2"
              role={testResult.status === 'FAILED' ? 'alert' : 'status'}
            >
              <div className="flex items-center justify-between">
                <span className={`text-xs font-semibold flex items-center gap-1.5 ${
                  testResult.status === 'FAILED' ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
                }`}>
                  {testResult.status === 'FAILED'
                    ? <CircleAlert className="h-4 w-4" />
                    : <CheckCircle2 className="h-4 w-4" />}
                  {testResult.status === 'FAILED' ? 'Workflow test failed' : 'Execution Result'}
                </span>
                <Badge variant="neutral" className="font-mono text-[10px]">
                  {String(testResult.status)}
                </Badge>
              </div>
              <p className="text-xs text-foreground">{String(testResult.message)}</p>
              {testOperationId && <Link className="text-sm underline" to={`/operations?operation=${encodeURIComponent(testOperationId)}`}>Open operation details and human review</Link>}
              {/* AWEB-WORKFLOW-SIMULATION-HONESTY: an empty stage list must never
                  read as a run that succeeded. Say whose stages are missing and
                  what that means instead of dumping a silent []. */}
              {testResult.dataSource === 'simulation' ? (
                Array.isArray(testResult.simulatedStages) && testResult.simulatedStages.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Stages walked by this simulation ({testResult.simulatedStages.length}):{' '}
                    {testResult.simulatedStages.map((stage) => String(stage)).join(', ')}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">No stages defined for this workflow.</span>{' '}
                    The workflow returned no stage list, so this simulation walked an empty flow: no stage ran, and an
                    empty result is a configuration gap, not a passing run.
                  </p>
                )
              ) : Array.isArray(testResult.stagesCompleted) && testResult.stagesCompleted.length > 0 ? null : (
                <p className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">No stage list returned for this run.</span>{' '}
                  The backend accepted the workflow but returned no stages, so per-stage outcomes cannot be shown.
                </p>
              )}
              {typeof testResult.errorCode === 'string' && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  Error code: <code>{testResult.errorCode}</code>
                </p>
              )}
              {typeof testResult.pollingError === 'string' && (
                <div role="alert" className="space-y-1 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">
                  <p>{testResult.pollingError}</p>
                  {testOperationId ? <Link className="underline" to={`/operations?operation=${encodeURIComponent(testOperationId)}`}>Open operation details to refresh status</Link> : null}
                </div>
              )}
              <pre className="p-3 bg-background border rounded text-[11px] font-mono overflow-x-auto max-h-[160px]">
                {JSON.stringify(testResult, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
