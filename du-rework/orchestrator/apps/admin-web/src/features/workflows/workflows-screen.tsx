import { useEffect, useMemo, useState } from 'react';
import {
  Workflow,
  GitBranch,
  Play,
  Plus,
  RefreshCw,
  Copy,
  Check,
  ShieldCheck,
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
import { Modal } from '@/components/ui/dialog';
import { AlertBanner, LoadingState, EmptyState } from '@/components/ui/state-panel';
import {
  createAdminApiClient,
  type WorkflowCatalogItem,
} from '@/lib/api';
import { useTenant } from '@/lib/tenant-context';
import { parseBusinessPage, parseBusinessVersions } from '@/features/businesses/state';

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
  const { tenantId, tenant } = useTenant();

  const [workflows, setWorkflows] = useState<WorkflowCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [businesses, setBusinesses] = useState<string[]>([]);
  const [businessVersions, setBusinessVersions] = useState<string[]>([]);
  const [ownerBusinessId, setOwnerBusinessId] = useState('');
  const [ownerBusinessVersion, setOwnerBusinessVersion] = useState('');

  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowCatalogItem | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importJsonText, setImportJsonText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  // Test execution state
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testInputVariables, setTestInputVariables] = useState<Record<string, unknown>>({});
  const [testSource, setTestSource] = useState<WorkflowTestSource>('backend');
  const [testExecuting, setTestExecuting] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [copiedDigest, setCopiedDigest] = useState<string | null>(null);

  const fetchWorkflows = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.listWorkflows(tenantId ? { tenantId } : undefined);
      if (res.ok) {
        const items = res.data.items ?? [];
        setWorkflows(items);
        if (items.length > 0) {
          setSelectedWorkflow((prev) => {
            if (prev && items.some((i) => i.slug === prev.slug)) {
              return items.find((i) => i.slug === prev.slug) ?? items[0] ?? null;
            }
            return items[0] ?? null;
          });
        } else {
          setSelectedWorkflow(null);
        }
      } else {
        setError(res.problem?.title || res.problem?.code || 'Unable to load the workflow list.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'API connection error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
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
    if (!tenantId) {
      setError('Select an Organization / Tenant before activating a workflow.');
      return;
    }
    if (ownerBusinessId && !ownerBusinessVersion) {
      setError('Select a registered business version or clear the business assignment.');
      return;
    }
    setActionInProgress(preset.slug);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await client.provisionWorkflow({
        tenantId,
        ...(ownerBusinessId ? { businessId: ownerBusinessId, businessVersion: ownerBusinessVersion } : {}),
        schema: preset.schema,
      });
      if (res.ok) {
        setSuccessMsg(`Provisioned the sample workflow "${preset.name}" (${preset.slug} v1)!`);
        await fetchWorkflows();
      } else {
        setError(res.problem?.title || res.problem?.code || 'Failed to provision the workflow');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error while provisioning the workflow');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleImportSubmit = async () => {
    if (!tenantId) {
      setImportError('Select a Tenant first.');
      return;
    }
    if (ownerBusinessId && !ownerBusinessVersion) {
      setImportError('Select a registered business version or clear the business assignment.');
      return;
    }
    setImportError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(importJsonText);
    } catch {
      setImportError('The content is not valid JSON. Check the syntax and try again.');
      return;
    }
    setActionInProgress('custom-import');
    try {
      const res = await client.provisionWorkflow({
        tenantId,
        ...(ownerBusinessId ? { businessId: ownerBusinessId, businessVersion: ownerBusinessVersion } : {}),
        schema: parsed,
      });
      if (res.ok) {
        setImportModalOpen(false);
        setImportJsonText('');
        setSuccessMsg('Workflow loaded and provisioned into the catalog successfully.');
        await fetchWorkflows();
      } else {
        setImportError(res.problem?.title || res.problem?.code || 'The workflow schema failed validation.');
      }
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Error while saving the workflow');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRetireWorkflow = async (wf: WorkflowCatalogItem) => {
    if (!tenantId) return;
    if (!confirm(`Retire the workflow "${wf.name || wf.slug}" (revision ${wf.revision})?`)) {
      return;
    }
    setActionInProgress(wf.slug);
    setError(null);
    try {
      const res = await client.retireWorkflow({
        tenantId,
        slug: wf.slug,
        expectedRevision: wf.revision,
      });
      if (res.ok) {
        setSuccessMsg(`Retired workflow "${wf.slug}" revision ${wf.revision}.`);
        await fetchWorkflows();
      } else {
        setError(res.problem?.title || res.problem?.code || 'Error while retiring the workflow');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection error');
    } finally {
      setActionInProgress(null);
    }
  };

  const openTestModal = (wf: WorkflowCatalogItem) => {
    setSelectedWorkflow(wf);
    setTestSource('backend');
    const schema = wf.schema as { input_schema?: { properties?: Record<string, { default?: unknown }> } } | undefined;
    const defaults: Record<string, unknown> = {};
    if (schema?.input_schema?.properties) {
      for (const [k, v] of Object.entries(schema.input_schema.properties)) {
        defaults[k] = v.default ?? '';
      }
    }
    setTestInputVariables(defaults);
    setTestResult(null);
    setTestModalOpen(true);
  };

  const handleExecuteTest = async () => {
    if (!selectedWorkflow || !tenantId) return;
    setTestExecuting(true);
    setTestResult(null);
    try {
      if (testSource === 'simulation') {
        setTestResult({
          status: 'SIMULATED_SUCCESS',
          dataSource: 'simulation',
          message: `Workflow '${selectedWorkflow.slug}' was simulated locally; no backend request was sent.`,
          inputEcho: testInputVariables,
          simulatedStages: selectedWorkflow.stages ?? [],
          executedAt: new Date().toISOString(),
        });
        return;
      }

      const res = await client.postAction('workflow.test', {
        tenantId,
        slug: selectedWorkflow.slug,
        variables: testInputVariables,
      });
      if (res.ok) {
        const responseData = res.data as Record<string, unknown>;
        const operationId = typeof responseData.operationId === 'string' ? responseData.operationId : undefined;
        const stagesCompleted = Array.isArray(responseData.stagesCompleted) &&
          responseData.stagesCompleted.every((stage): stage is string => typeof stage === 'string')
          ? responseData.stagesCompleted
          : undefined;
        setTestResult({
          status: 'ACCEPTED',
          message: `Workflow '${selectedWorkflow.slug}' was accepted by the backend.`,
          ...(operationId ? { operationId } : {}),
          inputEcho: testInputVariables,
          executedAt: new Date().toISOString(),
          ...(stagesCompleted ? { stagesCompleted } : {}),
        });
      } else {
        const errorCode = res.problem.code ?? (res.status === 0 ? 'TRANSPORT_ERROR' : `HTTP_${res.status}`);
        setTestResult({
          status: 'FAILED',
          message: res.problem.title ?? 'The backend could not start this workflow test.',
          errorCode,
          httpStatus: res.status,
        });
      }
    } catch (error) {
      const errorCode =
        typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'REQUEST_EXCEPTION';
      setTestResult({
        status: 'FAILED',
        message: error instanceof Error ? error.message : 'The workflow test request failed unexpectedly.',
        errorCode,
      });
    } finally {
      setTestExecuting(false);
    }
  };

  return (
    <div className="space-y-6">
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

        <div className="flex items-center gap-2">
          <Badge variant="success" className="flex items-center gap-1.5 py-1 px-3">
            <ShieldCheck className="h-3.5 w-3.5" />
            Vault Transit Encrypted
          </Badge>
          {tenant && (
            <Badge variant="neutral" className="py-1 px-3">
              Organization: <strong className="ml-1">{tenant.name}</strong>
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={fetchWorkflows}
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
              setImportJsonText(JSON.stringify(PRESET_SAMPLES[0]?.schema, null, 2));
              setImportModalOpen(true);
            }}
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
          {error}
        </AlertBanner>
      )}
      {successMsg && (
        <AlertBanner variant="success" title="Success">
          {successMsg}
        </AlertBanner>
      )}

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
              <CardTitle className="text-lg">Business Workflow Templates (Ready To Test)</CardTitle>
            </div>
            <Badge variant="info" className="text-xs">
              3 Standardized Scenarios
            </Badge>
          </div>
          <CardDescription>
            Pick a business workflow template below to provision it into the current Organization and test it right away.
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
                      disabled={isBusy}
                      onClick={() => handleProvisionPreset(preset)}
                      className="gap-1.5"
                    >
                      {isBusy ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      ) : isProvisioned ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5" /> Load Latest Version
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
                  Workflow List ({workflows.length})
                </CardTitle>
              </div>
              <CardDescription>
                The schemas currently configured for this tenant.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-2">
              {loading && workflows.length === 0 ? (
                <div className="p-6">
                  <LoadingState title="Loading..." description="Loading the workflow list..." />
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
                    >
                      Activate The IDP Pipeline Sample
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  {workflows.map((wf) => {
                    const isSelected = selectedWorkflow?.slug === wf.slug && selectedWorkflow?.revision === wf.revision;
                    return (
                      <button
                        key={`${wf.slug}-${wf.revision}`}
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
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => openTestModal(selectedWorkflow)}
                      className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      <Play className="h-4 w-4 fill-current" /> Test Run
                    </Button>
                    {selectedWorkflow.status === 'active' && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleRetireWorkflow(selectedWorkflow)}
                        disabled={actionInProgress === selectedWorkflow.slug}
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
                      <div className="border rounded-lg overflow-hidden text-xs">
                        <table className="w-full">
                          <thead className="bg-muted text-muted-foreground border-b text-left">
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
                                      Bound
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
        onOpenChange={setImportModalOpen}
        title="Load & Activate A New Workflow Schema"
        description="Enter a LegacyWorkflowSchema JSON document. The data is encrypted through Vault Transit before it is stored."
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          {importError && (
            <AlertBanner variant="error" title="Schema Error">
              {importError}
            </AlertBanner>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium">JSON Schema content:</label>
              <div className="flex items-center gap-1.5">
                {PRESET_SAMPLES.map((p) => (
                  <Button
                    key={p.slug}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 text-[11px] px-2"
                    onClick={() => setImportJsonText(JSON.stringify(p.schema, null, 2))}
                  >
                    Use template {p.slug}
                  </Button>
                ))}
              </div>
            </div>
            <textarea
              rows={14}
              value={importJsonText}
              onChange={(e) => setImportJsonText(e.target.value)}
              placeholder="Paste the JSON schema here..."
              className="w-full font-mono text-xs p-3 rounded-lg border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => setImportModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleImportSubmit}
              disabled={actionInProgress === 'custom-import' || !importJsonText.trim()}
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

      {/* ── Modal 2: Workflow Test Run Console ─────────────── */}
      <Modal
        open={testModalOpen}
        onOpenChange={setTestModalOpen}
        title={`Workflow Test Run: ${selectedWorkflow?.name || selectedWorkflow?.slug}`}
        description="Choose a data source: Backend sends a request to Orchestrator; local simulation sends no request."
        maxWidth="max-w-2xl"
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
                      onChange={(e) =>
                        setTestInputVariables({
                          ...testInputVariables,
                          [key]: e.target.value,
                        })
                      }
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
            <Button variant="outline" size="sm" onClick={() => setTestModalOpen(false)}>
              Close
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={handleExecuteTest}
              disabled={testExecuting}
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
