"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Loader2, Plus, Upload, FileText, Code, Play, Trash2,
  Edit3, Eye, Download, ChevronDown, ChevronUp, Zap,
  Settings, List, Grid, Search, X, AlertCircle, CheckCircle
} from "lucide-react";
import { toast } from "sonner";

interface WorkflowSchemaSummary {
  slug: string;
  name: string;
  version?: number;
  description?: string;
}

interface WorkflowSchema {
  slug: string;
  name: string;
  version?: number;
  description?: string;
  input_schema?: {
    type: "object";
    properties: Record<string, {
      type: string;
      label?: string;
      required?: boolean;
      widget?: string;
      description?: string;
      default?: unknown;
    }>;
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
  const [selectedSchema, setSelectedSchema] = useState<WorkflowSchema | null>(null);
  const [showSchemaModal, setShowSchemaModal] = useState(false);

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
      const form = new FormData();
      form.append("schema", importFile);
      const res = await fetch("/api/internal/workflow-schemas", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const { error } = await res.json();
        throw new Error(error || "Import failed");
      }
      toast.success("Đã import schema");
      setShowImportModal(false);
      setImportFile(null);
      loadSchemas();
    } catch (e: any) {
      toast.error(e.message || "Import thất bại");
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
        onRun={(slug) => router.push(`/workflow-builder/run?slug=${slug}`)}
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
                  <button onClick={() => router.push(`/workflow-builder/run?slug=${s.slug}`)} className="p-2 hover:bg-muted rounded-lg" title="Chạy thử"><Play className="w-4 h-4 text-green-600" /></button>
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
                  <button onClick={() => router.push(`/workflow-builder/run?slug=${s.slug}`)} className="flex-1 btn-primary flex items-center justify-center gap-1"><Play className="w-4 h-4" /> Chạy</button>
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
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
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
  const [runLoading, setRunLoading] = useState(false);
  const [runResult, setRunResult] = useState<any>(null);

  const handleRun = async () => {
    setRunLoading(true);
    setRunResult(null);
    try {
      const res = await fetch("/api/v1/docs/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema, input: {} }), // TODO: form input cho variables
      });
      const data = await res.json();
      setRunResult(data);
      if (res.ok) toast.success("Workflow đã khởi chạy");
      else toast.error(data.error || "Chạy thất bại");
    } catch {
      toast.error("Lỗi kết nối");
    } finally {
      setRunLoading(false);
    }
  };

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
          <button onClick={() => onRun(schema.slug)} className="btn-primary" disabled={runLoading}>
            <Play className="w-4 h-4" /> {runLoading ? "Đang chạy..." : "Chạy thử"}
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
        <SchemaInfoCard title="Nodes ({schema.nodes.length})" icon={Zap}>
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
      </div>

      {/* Run Result */}
      {runResult && (
        <div className="rounded-xl border border-border p-4 bg-muted/30">
          <h3 className="font-semibold mb-2">Kết quả chạy thử</h3>
          <pre className="text-xs bg-background p-3 rounded overflow-auto max-h-96">{JSON.stringify(runResult, null, 2)}</pre>
        </div>
      )}
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
