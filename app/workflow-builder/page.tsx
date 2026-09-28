"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Loader2, Plus, Upload, FileText, Play, Trash2,
  Eye, ChevronUp, Zap,
  Settings, List, Grid, Search, X
} from "lucide-react";
import { toast } from "sonner";
import {
  findMissingRequiredField,
  submitRunSchema,
} from "./run-schema-client";
import {
  submitDuOperation,
  pollDuOperation,
  decideRunEngine,
  buildSubmissionForEngine,
  resumeDuOperation,
  type DuFetcher,
  type RunEngine,
  type RunEngineDecision,
  type DuOperationDetail,
} from "./du-operation-adapter";

interface WorkflowSchemaSummary {
  slug: string;
  name: string;
  version?: number;
  description?: string;
}

interface WorkflowSchemaProperty {
  type: "string" | "number" | "boolean" | "string[]" | "object";
  label?: string;
  required?: boolean;
  widget?: string; // textarea / number / select
  description?: string;
  default?: unknown;
}

interface WorkflowSchema {
  slug: string;
  name: string;
  version?: number;
  description?: string;
  input_schema?: {
    type: "object";
    properties: Record<string, WorkflowSchemaProperty>;
  };
  nodes: Array<{
    id: string;
    type: string;
    connector?: string;
    description?: string;
    inputs?: Record<string, unknown>;
    source?: unknown;
    urls?: unknown;
    url?: unknown;
    message?: string;
    branches?: Array<Array<any>>;
  }>;
  flow: string[];
  output?: {
    from?: string;
    extra_data_from?: string;
  };
  /**
   * W33-CC: when true, the Run modal submits via the standard DU
   * Operation adapter (`/api/v1/operations`) with a deterministic
   * idempotency key, then polls until terminal. When false / undefined,
   * the existing legacy `submitRunSchema` flow is used (backward
   * compatible). Optional — schemas that don't declare it stay on the
   * legacy path.
   */
  useDuAdapter?: boolean;
  /** Optional override for the canonical `businessId` field on submit. */
  businessId?: string;
  /** Optional override for the canonical `action` field on submit. */
  action?: string;
  /**
   * Optional polling config used by the DU adapter path. `maxAttempts`
   * defaults to 30 and `intervalMs` defaults to 2000 when omitted.
   */
  duPoll?: {
    maxAttempts?: number;
    intervalMs?: number;
  };
}

export default function WorkflowBuilderPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isAdmin = session?.user?.role === "ADMIN";

  const [schemas, setSchemas] = useState<WorkflowSchemaSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [searchQuery, setSearchQuery] = useState("");
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  // Run Modal state
  const [runModalSlug, setRunModalSlug] = useState<string | null>(null);
  const [runModalSchema, setRunModalSchema] = useState<WorkflowSchema | null>(null);
  const [runInputs, setRunInputs] = useState<Record<string, unknown>>({});
  const [runFiles, setRunFiles] = useState<File[]>([]);
  const [runSubmitting, setRunSubmitting] = useState(false);
  // W34-CC: engine selector toggle inside the Run modal. Initialized
  // from the schema-declared `useDuAdapter` when the modal opens; user
  // can flip per-submit. Defaults to 'du_adapter' for new schemas that
  // do not declare a preference (the packet's "khuyên dùng" default).
  const [runEngine, setRunEngine] = useState<RunEngine>('du_adapter');
  // W36-CC: HITL pause/resume state. When a polled operation reaches
  // `WAITING_INPUT`, `hitlContext` is populated and the Run modal
  // surfaces a review card with editable JSON. `hitlResumePayload`
  // holds the user-edited extracted_data. `hitlResuming` releases the
  // submit button while the resume call is in flight.
  const [hitlContext, setHitlContext] = useState<
    | { operationId: string; step?: number; suggestedExtractedData?: unknown }
    | null
  >(null);
  const [hitlResumePayload, setHitlResumePayload] = useState<string>('{}');
  const [hitlResuming, setHitlResuming] = useState(false);
  const [hitlError, setHitlError] = useState<string | null>(null);

  // Parse ?detail=slug from URL
  const detailSlug = searchParams.get("detail");
  const [detailSchema, setDetailSchema] = useState<WorkflowSchema | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (status === "loading") return;
    if (!session) {
      router.push("/login");
      return;
    }
    if (!isAdmin) {
      toast.error("Chỉ Admin mới truy cập được Workflow Builder");
      router.push("/");
      return;
    }
    loadSchemas();
  }, [session, status, isAdmin, router]);

  useEffect(() => {
    if (detailSlug) {
      loadDetail(detailSlug);
    } else {
      setDetailSchema(null);
    }
  }, [detailSlug, router]);

  async function loadSchemas() {
    try {
      const res = await fetch("/api/internal/workflow-schemas");
      if (!res.ok) throw new Error("Failed to load");
      const { schemas } = await res.json();
      setSchemas(schemas);
    } catch (e) {
      toast.error("Không tải được danh sách workflow");
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(slug: string) {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/internal/workflow-schemas?slug=${slug}`);
      if (!res.ok) throw new Error("Not found");
      const { schema } = await res.json();
      setDetailSchema(schema);
    } catch (e) {
      toast.error("Không tải được chi tiết schema");
      router.push("/workflow-builder");
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    if (!importFile) return toast.error("Chọn file .json hoặc .xml");
    setImporting(true);
    try {
      const text = await importFile.text();
      const isXml = importFile.name.toLowerCase().endsWith(".xml");
      let body: unknown;
      if (isXml) {
        body = { xml: text };
      } else {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { throw new Error("File JSON không hợp lệ"); }
        body = { schema: parsed };
      }
      const res = await fetch("/api/internal/workflow-schemas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const { error } = await res.json();
        throw new Error(error || "Import failed");
      }
      toast.success("Đã import schema");
      setShowImportModal(false);
      setImportFile(null);
      loadSchemas();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Import thất bại";
      toast.error(msg);
    } finally {
      setImporting(false);
    }
  }

  async function handleDelete(slug: string) {
    if (!confirm(`Xóa schema "${slug}"?`)) return;
    try {
      const res = await fetch(`/api/internal/workflow-schemas?slug=${slug}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Xóa thất bại");
      toast.success("Đã xóa");
      loadSchemas();
    } catch {
      toast.error("Xóa thất bại");
    }
  }

  // ── Run modal helpers ────────────────────────────────────────────────────

  async function openRunModal(slug: string) {
    setRunModalSlug(slug);
    setRunModalSchema(null);
    setRunInputs({});
    setRunFiles([]);
    // W34-CC: prefill the engine toggle from the schema's
    // `useDuAdapter` declaration. When the schema doesn't declare one
    // (`useDuAdapter === undefined`), the modal opens on the packet's
    // "khuyên dùng" default ('du_adapter'). The user can still flip
    // the toggle per-submit.
    setRunEngine('du_adapter');
    try {
      const res = await fetch(`/api/internal/workflow-schemas?slug=${slug}`);
      if (!res.ok) throw new Error("Not found");
      const { schema } = (await res.json()) as { schema: WorkflowSchema };
      // Pre-fill defaults from input_schema
      const defaults: Record<string, unknown> = {};
      for (const [k, prop] of Object.entries(schema.input_schema?.properties ?? {})) {
        if (prop.default !== undefined && prop.default !== null) {
          defaults[k] = prop.default;
        }
      }
      setRunModalSchema(schema);
      setRunInputs(defaults);
      // Now overlay the schema's declared preference if any.
      if (schema.useDuAdapter === true) setRunEngine('du_adapter');
      else if (schema.useDuAdapter === false) setRunEngine('legacy');
    } catch {
      toast.error("Không tải được schema để chạy");
      setRunModalSlug(null);
    }
  }

  function closeRunModal() {
    setRunModalSlug(null);
    setRunModalSchema(null);
    setRunInputs({});
    setRunFiles([]);
    setRunSubmitting(false);
    setRunEngine('du_adapter');
    setHitlContext(null);
    setHitlResumePayload('{}');
    setHitlResuming(false);
    setHitlError(null);
  }

  async function submitRun() {
    if (!runModalSchema) return;
    // Validate required fields via the typed helper (Fix 5 contract).
    const missing = findMissingRequiredField(
      runInputs,
      runModalSchema.input_schema?.properties,
    );
    if (missing) {
      toast.error(`Trường "${missing.label}" là bắt buộc`);
      return;
    }

    // W34-CC: dual-mode dispatch via `decideRunEngine`. The user's
    // current `runEngine` toggle value wins when set; the schema's
    // `useDuAdapter` only pre-fills the toggle. The typed decision
    // carries the resolved engine + canonical `businessId` / `action`
    // overrides so both code paths see a consistent payload.
    const decision: RunEngineDecision = decideRunEngine(runModalSchema, runEngine);
    if (decision.engine === 'du_adapter') {
      await submitDuAdapterFlow(runModalSchema, runInputs, runFiles, decision);
    } else {
      await submitLegacyFlow(runModalSchema, runInputs, runFiles);
    }
  }

  /** Legacy path: POST /api/v1/docs/workflows/schema via `submitRunSchema`. */
  async function submitLegacyFlow(
    schema: WorkflowSchema,
    inputs: Record<string, unknown>,
    files: File[],
  ): Promise<void> {
    setRunSubmitting(true);
    try {
      const outcome = await submitRunSchema({
        schemaSlug: schema.slug,
        inputs,
        files,
      });
      if (outcome.ok) {
        toast.success("Workflow đã khởi chạy");
        closeRunModal();
        router.push(outcome.operationUrl);
      } else {
        toast.error(outcome.detail);
      }
    } finally {
      setRunSubmitting(false);
    }
  }

  /**
   * W33-CC + W34-CC dual-mode path. Delegates to the pure
   * `runDuSubmitPipeline` orchestrator (mapping → submit →
   * poll-to-terminal) and consumes the typed outcome for toast +
   * navigation. The injected `DuFetcher` defaults to the global
   * `fetch`; tests inject a pure mock via
   * `tests/workflow-builder/ui-integration.test.ts`. The optional
   * `decision` carries the resolved `businessId` / `action` overrides
   * from `decideRunEngine`; when absent, the schema-level overrides
   * are used.
   */
  async function submitDuAdapterFlow(
    schema: WorkflowSchema,
    inputs: Record<string, unknown>,
    files: File[],
    decision?: RunEngineDecision,
    fetcher: DuFetcher = fetch,
  ): Promise<void> {
    setRunSubmitting(true);
    try {
      // W36-CC: split submit + poll so we can branch on `WAITING_INPUT`
      // (HITL pause) before reaching a terminal state. The pipeline
      // helper is still used as the orchestrator for terminal polling,
      // but the page additionally needs to detect WAITING_INPUT and
      // expose the typed context to the resume card.
      const submission = buildSubmissionForEngine(
        {
          slug: schema.slug,
          useDuAdapter: schema.useDuAdapter,
          businessId: schema.businessId,
          action: schema.action,
        },
        decision ?? decideRunEngine(schema, 'du_adapter'),
        inputs,
        files.map((f) => ({ name: f.name, size: f.size, mime: f.type })),
      );
      const submitOutcome = await submitDuOperation(submission, fetcher);
      if (!submitOutcome.ok || !submitOutcome.created) {
        toast.error(submitOutcome.detail);
        return;
      }
      const opId = submitOutcome.created.operationId;
      toast.success("Workflow đã khởi chạy");

      const pollMaxAttempts = schema.duPoll?.maxAttempts ?? 30;
      const pollIntervalMs = schema.duPoll?.intervalMs ?? 2000;

      let attempt = 0;
      let lastView: DuOperationDetail | null = null;
      // Inner poll loop with WAITING_INPUT branch.
      while (attempt < pollMaxAttempts) {
        const polled = await pollDuOperation(opId, fetcher);
        if (!polled.ok || !polled.view) {
          toast.error(polled.detail);
          return;
        }
        lastView = polled.view;
        if (polled.terminal) {
          break;
        }
        if (lastView.state === 'WAITING_INPUT') {
          // Surface the typed HITL context; the resume card will call
          // `resumeDuOperation` and re-enter the poll loop.
          setHitlContext({
            operationId: opId,
            step: undefined,
            suggestedExtractedData: undefined,
          });
          setHitlResumePayload('{}');
          toast.info('Workflow tạm dừng chờ xác nhận (WAITING_INPUT).');
          return;
        }
        attempt++;
        if (pollIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
      }

      const terminalState = lastView?.state ?? 'UNKNOWN';
      if (terminalState === 'SUCCEEDED') {
        toast.success(`Hoàn tất: ${terminalState}`);
      } else if (
        terminalState === 'FAILED' ||
        terminalState === 'CANCELLED' ||
        terminalState === 'TIMED_OUT'
      ) {
        toast.error(`Kết thúc: ${terminalState}`);
      }
      closeRunModal();
      router.push(`/operations/${opId}`);
    } finally {
      setRunSubmitting(false);
    }
  }

  /**
   * W36-CC: HITL resume action. Called from the modal's "Xác nhận &
   * Tiếp tục (Resume)" button when `hitlContext` is populated.
   * Parses the user-edited JSON, calls `resumeDuOperation`, then
   * resumes polling until a terminal state is observed.
   */
  async function resumeHitlFlow(
    ctx: { operationId: string; step?: number },
    fetcher: DuFetcher = fetch,
  ): Promise<void> {
    if (hitlResuming) return;
    setHitlResuming(true);
    try {
      let extractedData: unknown = undefined;
      const trimmed = hitlResumePayload.trim();
      if (trimmed.length > 0) {
        try {
          extractedData = JSON.parse(trimmed);
        } catch {
          toast.error('JSON không hợp lệ trong trường extracted_data');
          return;
        }
      }
      const resumeOutcome = await resumeDuOperation(
        ctx.operationId,
        { step: ctx.step, extracted_data: extractedData },
        fetcher,
      );
      if (!resumeOutcome.ok) {
        if (resumeOutcome.conflict || resumeOutcome.status === 409) {
          setHitlError(
            resumeOutcome.detail ||
              'Xung đột phiên bản (409 Conflict): Operation không còn ở trạng thái WAITING_INPUT.',
          );
        }
        toast.error(resumeOutcome.detail);
        return;
      }
      setHitlError(null);
      toast.success('Đã gửi resume. Tiếp tục theo dõi...');
      // Continue polling after resume.
      const pollMaxAttempts = 30;
      const pollIntervalMs = 2000;
      let attempt = 0;
      let lastView: DuOperationDetail | null = resumeOutcome.view ?? null;
      while (attempt < pollMaxAttempts) {
        const polled = await pollDuOperation(ctx.operationId, fetcher);
        if (!polled.ok || !polled.view) {
          toast.error(polled.detail);
          return;
        }
        lastView = polled.view;
        if (polled.terminal) break;
        attempt++;
        if (pollIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
      }
      const terminalState = lastView?.state ?? 'UNKNOWN';
      if (terminalState === 'SUCCEEDED') toast.success(`Hoàn tất: ${terminalState}`);
      else if (terminalState === 'FAILED' || terminalState === 'CANCELLED' || terminalState === 'TIMED_OUT') {
        toast.error(`Kết thúc: ${terminalState}`);
      }
      setHitlContext(null);
      closeRunModal();
      router.push(`/operations/${ctx.operationId}`);
    } finally {
      setHitlResuming(false);
    }
  }

  function renderInputField(key: string, prop: WorkflowSchemaProperty) {
    const value = runInputs[key];
    const setValue = (v: unknown) => setRunInputs((prev) => ({ ...prev, [key]: v }));
    const label = (
      <label className="block text-sm font-medium mb-1">
        {prop.label ?? key}
        {prop.required && <span className="text-red-500 ml-1">*</span>}
      </label>
    );
    const desc = prop.description ? <p className="text-xs text-muted-foreground mt-1">{prop.description}</p> : null;

    if (prop.widget === "textarea") {
      return (
        <div key={key} className="mb-3">
          {label}
          <textarea
            className="w-full border border-border rounded-lg p-2 min-h-[80px]"
            placeholder={prop.description}
            value={typeof value === "string" ? value : value != null ? JSON.stringify(value) : ""}
            onChange={(e) => setValue(e.target.value)}
          />
          {desc}
        </div>
      );
    }

    switch (prop.type) {
      case "number":
        return (
          <div key={key} className="mb-3">
            {label}
            <input
              type="number"
              className="w-full border border-border rounded-lg p-2"
              value={value == null ? "" : String(value)}
              onChange={(e) => setValue(e.target.value === "" ? undefined : Number(e.target.value))}
            />
            {desc}
          </div>
        );
      case "boolean":
        return (
          <div key={key} className="mb-3 flex items-center gap-2">
            <input
              id={`run-${key}`}
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => setValue(e.target.checked)}
              className="w-4 h-4"
            />
            <label htmlFor={`run-${key}`} className="text-sm">{prop.label ?? key}{prop.required && <span className="text-red-500">*</span>}</label>
            {desc}
          </div>
        );
      case "string[]": {
        const arrValue = Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "";
        return (
          <div key={key} className="mb-3">
            {label}
            <textarea
              className="w-full border border-border rounded-lg p-2 min-h-[60px]"
              placeholder="Một giá trị mỗi dòng"
              value={arrValue}
              onChange={(e) => setValue(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
            />
            <p className="text-xs text-muted-foreground">Mỗi dòng một giá trị</p>
            {desc}
          </div>
        );
      }
      default: {
        const isObj = prop.type === "object";
        const displayVal = isObj
          ? (value != null ? JSON.stringify(value, null, 2) : "")
          : typeof value === "string" ? value : value != null ? JSON.stringify(value) : "";
        return (
          <div key={key} className="mb-3">
            {label}
            <textarea
              className="w-full border border-border rounded-lg p-2 font-mono text-sm min-h-[70px]"
              placeholder={isObj ? '{"key":"value"}' : ""}
              value={displayVal}
              onChange={(e) => {
                if (!isObj) { setValue(e.target.value); return; }
                try { setValue(JSON.parse(e.target.value)); } catch { setValue(e.target.value); }
              }}
            />
            {isObj && <p className="text-xs text-muted-foreground">Nhập JSON hợp lệ</p>}
            {desc}
          </div>
        );
      }
    }
  }

  function openDetail(slug: string) {
    router.push(`/workflow-builder?detail=${slug}`);
  }

  function closeDetail() {
    router.push("/workflow-builder");
    setDetailSchema(null);
  }

  const filtered = schemas.filter(s =>
    s.slug.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ── Detail view mode ──
  if (detailSchema) {
    return (
      <WorkflowDetailView
        schema={detailSchema}
        loading={detailLoading}
        onClose={closeDetail}
        onRun={(slug) => openRunModal(slug)}
      />
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Workflow Builder</h1>
          <p className="text-muted-foreground">Quản lý & chạy Schema-driven Business Workflow</p>
        </div>
        <button
          className="btn-primary flex items-center gap-2"
          onClick={() => setShowImportModal(true)}
        >
          <Upload className="w-4 h-4" />
          Import Schema
        </button>
      </div>

      {/* Search + View Toggle */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Tìm theo slug hoặc tên..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-border rounded-lg bg-background focus:ring-2 focus:ring-primary"
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode("list")}
            className={`p-2 rounded-lg ${viewMode === "list" ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/50"}`}
            title="Danh sách"
          ><List className="w-4 h-4" /></button>
          <button
            onClick={() => setViewMode("grid")}
            className={`p-2 rounded-lg ${viewMode === "grid" ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/50"}`}
            title="Lưới"
          ><Grid className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Schema List */}
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className="text-lg">{searchQuery ? "Không tìm thấy schema" : "Chưa có schema nào"}</p>
          <button className="btn-primary mt-4" onClick={() => setShowImportModal(true)}>
            <Plus className="w-4 h-4 mr-2" /> Import schema đầu tiên
          </button>
        </div>
      ) : (
        viewMode === "list" ? (
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="grid grid-cols-[1fr_2fr_1fr_1fr_auto] gap-4 p-3 bg-muted/50 text-xs font-medium text-muted-foreground">
              <span>Slug</span><span>Tên / Mô tả</span><span>Version</span><span>Nodes</span><span className="text-right">Actions</span>
            </div>
            {filtered.map((s) => (
              <div key={s.slug} className="grid grid-cols-[1fr_2fr_1fr_1fr_auto] gap-4 p-3 border-t border-border hover:bg-muted/30 transition-colors items-center">
                <code className="font-mono text-sm">{s.slug}</code>
                <div>
                  <p className="font-medium">{s.name}</p>
                  {s.description && <p className="text-sm text-muted-foreground truncate max-w-md">{s.description}</p>}
                </div>
                <span className="text-muted-foreground">v{s.version || 1}</span>
                <span className="text-muted-foreground">—</span>
                <div className="flex items-center gap-2 justify-end">
                  <button onClick={() => openDetail(s.slug)} className="p-2 hover:bg-muted rounded-lg" title="Xem chi tiết"><Eye className="w-4 h-4" /></button>
                  <button onClick={() => openRunModal(s.slug)} className="p-2 hover:bg-muted rounded-lg" title="Chạy thử"><Play className="w-4 h-4 text-green-600" /></button>
                  <button onClick={() => handleDelete(s.slug)} className="p-2 hover:bg-muted rounded-lg text-red-600" title="Xóa"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((s) => (
              <div key={s.slug} className="border border-border rounded-xl p-4 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{s.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{s.slug}</p>
                    {s.description && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{s.description}</p>}
                  </div>
                  <span className="px-2 py-0.5 text-xs bg-muted rounded-full">v{s.version || 1}</span>
                </div>
                <div className="flex items-center gap-2 mt-4 pt-4 border-t border-border">
                  <button onClick={() => openDetail(s.slug)} className="flex-1 btn-outline flex items-center justify-center gap-1"><Eye className="w-4 h-4" /> Xem</button>
                  <button onClick={() => openRunModal(s.slug)} className="flex-1 btn-primary flex items-center justify-center gap-1"><Play className="w-4 h-4" /> Chạy</button>
                  <button onClick={() => handleDelete(s.slug)} className="p-2 text-red-600 hover:bg-red-50 rounded-lg" title="Xóa"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowImportModal(false)}>
          <div className="bg-card rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-bold mb-4">Import Workflow Schema</h2>
            <form onSubmit={handleImport}>
              <div className="mb-4">
                <label className="block text-sm font-medium mb-2">File .json hoặc .xml</label>
                <input
                  type="file"
                  accept=".json,.xml"
                  onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                  className="w-full border border-border rounded-lg p-2"
                  required
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" className="btn-outline flex-1" onClick={() => { setShowImportModal(false); setImportFile(null); }}>Hủy</button>
                <button type="submit" className="btn-primary flex-1" disabled={importing || !importFile}>
                  {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Import"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Run Modal */}
      {runModalSlug && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={closeRunModal}>
          <div className="bg-card rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-xl font-bold">Chạy workflow</h2>
                <p className="text-sm text-muted-foreground font-mono">{runModalSlug}</p>
              </div>
              <button onClick={closeRunModal} className="p-2 hover:bg-muted rounded-lg" title="Đóng"><X className="w-5 h-5" /></button>
            </div>

            {!runModalSchema ? (
              <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); void submitRun(); }}>
                {/* Auto-generated input fields from input_schema */}
                {Object.entries(runModalSchema.input_schema?.properties ?? {}).length > 0 ? (
                  Object.entries(runModalSchema.input_schema!.properties).map(([key, prop]) =>
                    renderInputField(key, prop)
                  )
                ) : (
                  <p className="text-sm text-muted-foreground mb-3">Workflow này không yêu cầu biến đầu vào.</p>
                )}

                {/* File upload */}
                <div className="mb-4">
                  <label className="block text-sm font-medium mb-1">Tệp đính kèm (tùy chọn)</label>
                  <input
                    type="file"
                    multiple
                    onChange={(e) => setRunFiles(Array.from(e.target.files ?? []))}
                    className="w-full border border-border rounded-lg p-2"
                  />
                  {runFiles.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-1">{runFiles.length} tệp đã chọn</p>
                  )}
                </div>

                {/* W34-CC: Engine selector + settings. The user picks
                    between the DU Gateway Operation Adapter (recommended)
                    and the Legacy Runner before submitting. The toggle is
                    pre-filled from the schema's `useDuAdapter` declaration
                    (see `openRunModal`) but can be flipped per submit. The
                    `businessId` / `action` fields show the resolved
                    canonical overrides when set on the schema. */}
                <div className="mb-4 border-t border-border pt-4">
                  <p className="text-sm font-medium mb-2">Công cụ chạy</p>
                  <div className="flex flex-col gap-2" data-testid="run-engine-toggle">
                    <label
                      className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer ${
                        runEngine === 'du_adapter'
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:bg-muted/50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="runEngine"
                        value="du_adapter"
                        checked={runEngine === 'du_adapter'}
                        onChange={() => setRunEngine('du_adapter')}
                        className="mt-1"
                        data-testid="run-engine-du-adapter"
                      />
                      <span className="flex-1">
                        <span className="block text-sm font-medium">
                          DU Gateway Operations <span className="text-xs text-muted-foreground">(Khuyên dùng)</span>
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Submit qua <code>POST /api/v1/operations</code> với idempotency key xác định; theo dõi tới <code>/operations/&lt;id&gt;</code>.
                        </span>
                      </span>
                    </label>
                    <label
                      className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer ${
                        runEngine === 'legacy'
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:bg-muted/50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="runEngine"
                        value="legacy"
                        checked={runEngine === 'legacy'}
                        onChange={() => setRunEngine('legacy')}
                        className="mt-1"
                        data-testid="run-engine-legacy"
                      />
                      <span className="flex-1">
                        <span className="block text-sm font-medium">Legacy Runner</span>
                        <span className="block text-xs text-muted-foreground">
                          Submit qua <code>submitRunSchema</code> (multipart). Giữ tương thích với workflow hiện có.
                        </span>
                      </span>
                    </label>
                  </div>

                  {(runModalSchema.businessId || runModalSchema.action) && (
                    <p className="text-xs text-muted-foreground mt-2">
                      Canonical DU submission:
                      {runModalSchema.businessId && (
                        <> businessId=<code>{runModalSchema.businessId}</code></>
                      )}
                      {runModalSchema.action && <> · action=<code>{runModalSchema.action}</code></>}
                    </p>
                  )}
                </div>

                {/* W36-CC: HITL pause/resume card. Visible only while an
                    operation is in `WAITING_INPUT`. Provides editable JSON
                    for `extracted_data` and a "Xác nhận & Tiếp tục
                    (Resume)" button that calls `resumeDuOperation` and
                    resumes polling. */}
                {hitlContext && (
                  <div
                    className="mb-4 border-t border-border pt-4"
                    data-testid="hitl-review-card"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="px-2 py-0.5 text-xs bg-amber-100 text-amber-700 rounded">
                        WAITING_INPUT
                      </span>
                      <span className="text-xs text-muted-foreground font-mono">
                        {hitlContext.operationId}
                      </span>
                    </div>
                    <p className="text-sm font-medium mb-1">
                      Review dữ liệu trước khi tiếp tục
                    </p>
                    <p className="text-xs text-muted-foreground mb-2">
                      Chỉnh sửa <code>extracted_data</code> dưới đây (JSON), sau đó nhấn "Xác nhận &amp; Tiếp tục".
                    </p>
                    {hitlError && (
                      <div
                        className="p-2.5 mb-3 text-xs bg-red-50 text-red-700 border border-red-200 rounded-md flex items-center justify-between"
                        data-testid="hitl-conflict-error"
                      >
                        <span>{hitlError}</span>
                        <button
                          type="button"
                          className="text-red-500 hover:text-red-700 font-bold ml-2"
                          onClick={() => setHitlError(null)}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                    <textarea
                      className="w-full border border-border rounded-lg p-2 font-mono text-sm min-h-[140px]"
                      value={hitlResumePayload}
                      onChange={(e) => setHitlResumePayload(e.target.value)}
                      data-testid="hitl-resume-json"
                      placeholder='{"amount": 100, "currency": "VND"}'
                      spellCheck={false}
                    />
                    <div className="flex gap-2 justify-end mt-2">
                      <button
                        type="button"
                        className="btn-outline"
                        onClick={closeRunModal}
                        disabled={hitlResuming}
                      >
                        Hủy
                      </button>
                      <button
                        type="button"
                        className="btn-primary flex items-center gap-2"
                        disabled={hitlResuming}
                        onClick={() => resumeHitlFlow(hitlContext)}
                        data-testid="hitl-resume-button"
                      >
                        {hitlResuming ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Đang xác nhận...
                          </>
                        ) : (
                          'Xác nhận & Tiếp tục (Resume)'
                        )}
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex gap-2 justify-end pt-2 border-t border-border">
                  <button type="button" className="btn-outline flex-1" onClick={closeRunModal}>Hủy</button>
                  <button type="submit" className="btn-primary flex-1 flex items-center justify-center gap-2" disabled={runSubmitting}>
                    {runSubmitting
                      ? (<><Loader2 className="w-4 h-4 animate-spin" /> Đang khởi chạy...</>)
                      : (<><Play className="w-4 h-4" /> Chạy workflow</>)}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────────
   WorkflowDetailView — xem chi tiết + chạy test
────────────────────────────────────────────────────────────────────────── */

function WorkflowDetailView({
  schema,
  loading,
  onClose,
  onRun,
}: {
  schema: WorkflowSchema;
  loading: boolean;
  onClose: () => void;
  onRun: (slug: string) => void;
}) {
  // Pipeline Mappings state
  const [pipelineMappings, setPipelineMappings] = useState<any[] | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [overrideEdits, setOverrideEdits] = useState<Record<string, any>>({});
  const [savingOverride, setSavingOverride] = useState<string | null>(null);

  // Load pipeline mappings on mount
  useEffect(() => {
    if (!schema?.slug) return;
    setPipelineLoading(true);
    setPipelineError(null);
    fetch(`/api/internal/workflow-schemas/pipeline-mappings?slug=${schema.slug}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setPipelineError(data.error); return; }
        setPipelineMappings(data.pipelineMappings || []);
        const edits: Record<string, any> = {};
        for (const m of data.pipelineMappings || []) {
          edits[m.nodeId] = { ...m.currentOverrides };
        }
        setOverrideEdits(edits);
      })
      .catch(() => setPipelineError("Lỗi tải pipeline mappings"))
      .finally(() => setPipelineLoading(false));
  }, [schema?.slug]);

  async function saveOverride(nodeId: string) {
    setSavingOverride(nodeId);
    try {
      const res = await fetch("/api/internal/workflow-schemas/override", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: schema.slug, nodeId, overrides: overrideEdits[nodeId] || {} }),
      });
      const data = await res.json();
      if (res.ok) { toast.success("Đã lưu override"); }
      else { toast.error(data.error || "Lưu thất bại"); }
    } catch { toast.error("Lỗi kết nối"); }
    finally { setSavingOverride(null); }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button onClick={onClose} className="p-2 hover:bg-muted rounded-lg"><ChevronUp className="w-5 h-5" /></button>
        <div className="flex-1">
          <h2 className="text-2xl font-bold">{schema.name}</h2>
          <p className="text-muted-foreground font-mono">{schema.slug} {schema.version && `v${schema.version}`}</p>
          {schema.description && <p className="text-sm text-muted-foreground mt-1">{schema.description}</p>}
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-outline"><X className="w-4 h-4" /> Đóng</button>
          <button onClick={() => onRun(schema.slug)} className="btn-primary">
            <Play className="w-4 h-4" /> Chạy thử
          </button>
        </div>
      </div>

      {/* Schema Overview */}
      <div className="grid gap-4 md:grid-cols-3">
        <SchemaInfoCard title="Input Variables" icon={Settings}>
          <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-64">
            {schema.input_schema ? JSON.stringify(schema.input_schema.properties, null, 2) : "Không có"}
          </pre>
        </SchemaInfoCard>
        <SchemaInfoCard title={`Nodes (${schema.nodes.length})`} icon={Zap}>
          <div className="space-y-2 max-h-64 overflow-auto">
            {schema.nodes.map((n) => (
              <div key={n.id} className="flex items-center gap-2 p-2 bg-muted rounded text-sm">
                <span className="px-2 py-0.5 text-xs bg-primary/10 text-primary rounded">{n.type}</span>
                <code className="font-mono flex-1 truncate">{n.id}</code>
                {n.connector && <span className="text-muted-foreground text-xs">→ {n.connector}</span>}
                {n.message && <span className="text-xs text-amber-600">⏸ HITL</span>}
              </div>
            ))}
          </div>
        </SchemaInfoCard>
        <SchemaInfoCard title="Flow" icon={List}>
          <div className="space-y-1 font-mono text-sm">
            {schema.flow.map((id, i) => (
              <div key={id} className="flex items-center gap-2 text-muted-foreground">
                <span className="w-5 text-center">{i + 1}.</span>
                <span className="flex-1 truncate">{id}</span>
              </div>
            ))}
            {schema.output && (
              <div className="mt-2 p-2 bg-green-50 rounded text-green-700 text-xs">
                Output từ: <code>{schema.output.from}</code>
                {schema.output.extra_data_from && <span className="ml-2">+ data từ: <code>{schema.output.extra_data_from}</code></span>}
              </div>
            )}
          </div>
        </SchemaInfoCard>

        {/* Pipeline Mappings card */}
        <SchemaInfoCard title="Pipeline Mappings" icon={Settings}>
          {pipelineLoading ? (
            <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : pipelineError ? (
            <p className="text-sm text-red-500">{pipelineError}</p>
          ) : !pipelineMappings || pipelineMappings.length === 0 ? (
            <p className="text-sm text-muted-foreground">Không có connector nodes trong schema này</p>
          ) : (
            <div className="space-y-3 max-h-96 overflow-auto">
              {pipelineMappings.map((pm) => {
                const edit = overrideEdits[pm.nodeId] || {};
                return (
                  <div key={pm.nodeId} className="border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <code className="font-mono text-sm font-semibold">{pm.nodeId}</code>
                        <span className="ml-2 text-xs px-2 py-0.5 bg-primary/10 text-primary rounded">{pm.connectorSlug}</span>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground mb-2 space-y-0.5">
                      <p><span className="font-medium">Endpoint:</span> {pm.connectorName}</p>
                      {pm.connectorDescription && <p><span className="font-medium">Mô tả:</span> {pm.connectorDescription}</p>}
                      <p><span className="font-medium">Response path:</span> {pm.responseContentPath}</p>
                      <p><span className="font-medium">Timeout:</span> {pm.timeoutSec}s</p>
                    </div>
                    <div className="space-y-2 pt-2 border-t border-border">
                      <p className="text-xs font-medium text-muted-foreground">Override parameters</p>
                      <div>
                        <label className="text-xs text-muted-foreground">Prompt override</label>
                        <textarea
                          className="w-full border border-border rounded p-1.5 text-xs min-h-[50px]"
                          placeholder={pm.defaultPrompt?.substring(0, 60) + "..." || "Mặc định từ connector"}
                          value={edit.prompt !== undefined && edit.prompt !== null ? edit.prompt : ""}
                          onChange={(e) => setOverrideEdits((prev) => ({
                            ...prev,
                            [pm.nodeId]: { ...prev[pm.nodeId], prompt: e.target.value || undefined },
                          }))}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Static form fields (JSON)</label>
                        <input
                          className="w-full border border-border rounded p-1.5 text-xs"
                          placeholder={pm.staticFormFields || "Mặc định"}
                          value={edit.staticFormFields !== undefined ? edit.staticFormFields : ""}
                          onChange={(e) => setOverrideEdits((prev) => ({
                            ...prev,
                            [pm.nodeId]: { ...prev[pm.nodeId], staticFormFields: e.target.value || undefined },
                          }))}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Extra headers (JSON)</label>
                        <input
                          className="w-full border border-border rounded p-1.5 text-xs"
                          placeholder={pm.extraHeaders || "Mặc định"}
                          value={edit.extraHeaders !== undefined ? edit.extraHeaders : ""}
                          onChange={(e) => setOverrideEdits((prev) => ({
                            ...prev,
                            [pm.nodeId]: { ...prev[pm.nodeId], extraHeaders: e.target.value || undefined },
                          }))}
                        />
                      </div>
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="text-xs text-muted-foreground">Response content path</label>
                          <input
                            className="w-full border border-border rounded p-1.5 text-xs"
                            placeholder={pm.responseContentPath}
                            value={edit.responseContentPath !== undefined ? edit.responseContentPath : ""}
                            onChange={(e) => setOverrideEdits((prev) => ({
                              ...prev,
                              [pm.nodeId]: { ...prev[pm.nodeId], responseContentPath: e.target.value || undefined },
                            }))}
                          />
                        </div>
                        <div className="w-24">
                          <label className="text-xs text-muted-foreground">Timeout (s)</label>
                          <input
                            type="number"
                            className="w-full border border-border rounded p-1.5 text-xs"
                            placeholder={String(pm.timeoutSec)}
                            value={edit.timeoutSec !== undefined ? edit.timeoutSec : ""}
                            onChange={(e) => setOverrideEdits((prev) => ({
                              ...prev,
                              [pm.nodeId]: { ...prev[pm.nodeId], timeoutSec: e.target.value ? Number(e.target.value) : undefined },
                            }))}
                          />
                        </div>
                      </div>
                      <button
                        className="btn-primary text-xs py-1 px-2"
                        disabled={savingOverride === pm.nodeId}
                        onClick={() => saveOverride(pm.nodeId)}
                      >
                        {savingOverride === pm.nodeId ? "Đang lưu..." : "Lưu override"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SchemaInfoCard>
      </div>
    </div>
  );
}

function SchemaInfoCard({ title, icon: Icon, children }: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-5 h-5 text-muted-foreground" />
        <span className="font-semibold">{title}</span>
      </div>
      {children}
    </div>
  );
}
