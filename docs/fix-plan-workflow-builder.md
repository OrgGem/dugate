# Fix Plan: Workflow Builder — Full Audit & Repair

> **Branch**: `codex/fix-workflow-builder` (tạo từ `main`)
> **Mục tiêu**: Sửa tất cả issues để luồng import schema → chạy workflow hoạt động end-to-end
> **Kiểm tra**: `npx jest tests/workflow-builder` sau mỗi step

---

## Mục lục

1. [P0] Fix 1: UI Import — FormData → JSON
2. [P0] Fix 2: Cross-block binding resolution
3. [P0] Fix 3: API endpoint cho schema-driven workflow
4. [P1] Fix 4: Resume HITL — persist nodeResults
5. [P1] Fix 5: Nút "Chạy thử" — thay 404 bằng gọi API mới
6. [P2] Fix 6: XML converter — auth fields cho file_url_download & callback
7. [P2] Fix 7: XML converter — maxTotalBytes/maxEntries cho archive_extract
8. [P3] Fix 8: UI DetailView — lỗi hiển thị Nodes count
9. [Test] Fix 9: Cập nhật tests cho run-schema (cross-block, resume)
10. [Schema guide] Fix 10: Cập nhật docs/workflow-schema-guide.md

---

## Fix 1: UI Import — FormData → JSON ⚡P0

### Vấn đề
`page.tsx` gửi `FormData` với file object, nhưng API route dùng `req.json()` — không parse được multipart.

### File: `app/workflow-builder/page.tsx`
**Dòng 130-135**: Thay `handleImport`:

```typescript
async function handleImport(e: React.FormEvent) {
  e.preventDefault();
  if (!importFile) return toast.error("Chọn file .json hoặc .xml");
  setImporting(true);
  try {
    // Đọc file content → gửi JSON body
    const text = await importFile.text();
    const isXml = importFile.name.endsWith('.xml');
    let body: any;
    if (isXml) {
      body = { xml: text };
    } else {
      // Validate JSON trước khi gửi
      try { JSON.parse(text); } catch {
        throw new Error('File JSON không hợp lệ');
      }
      body = { schema: JSON.parse(text) };
    }

    const res = await fetch('/api/internal/workflow-schemas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const { error } = await res.json();
      throw new Error(error || 'Import failed');
    }
    toast.success('Đã import schema');
    setShowImportModal(false);
    setImportFile(null);
    loadSchemas();
  } catch (e: any) {
    toast.error(e.message || 'Import thất bại');
  } finally {
    setImporting(false);
  }
}
```

### Kiểm tra
- Upload file `.json` hợp lệ → import thành công
- Upload file `.xml` hợp lệ → import thành công
- Upload file `.json` không hợp lệ → báo lỗi

---

## Fix 2: Cross-block binding resolution ⚡P0

### Vấn đề
`runWorkflowFromSchema` chia flow thành blocks (các node không-human). Mỗi block gọi `runSchemaDag` riêng với `nodeResults = {}` mới. Block sau không thấy kết quả block trước → binding `$extract.content` bị undefined.

### File: `lib/workflow-builder/interpreter.ts`
**Sửa `RunDagOptions`** (dòng ~18-22): Thêm field `existingResults`:

```typescript
export interface RunDagOptions {
  schema: WorkflowSchema;
  input: Record<string, unknown>;
  files?: string[];
  exec?: ExecFunction;
  /** Existing node results to seed the execution (for cross-block resume) */
  existingResults?: Record<string, NodeResult>;
}
```

**Sửa `runSchemaDag`** (dòng ~120-125):

```typescript
export async function runSchemaDag(options: RunDagOptions): Promise<Record<string, NodeResult>> {
  const { schema, input, files } = options;
  const exec: ExecFunction = options.exec ?? defaultExec;

  const errors = validateSchema(schema);
  if (errors.length > 0) {
    throw new Error(`Invalid workflow schema: ${errors.join('; ')}`);
  }

  // 👇 DÙNG existingResults thay vì khởi tạo rỗng
  const nodeResults = options.existingResults ?? {};
  const ordered = schema.flow
    .map((id) => schema.nodes.find((n) => n.id === id))
    .filter((n): n is WorkflowNode => !!n);

  await runNodeSequence(ordered, nodeResults, input, files, exec);
  return nodeResults;
}
```

### File: `lib/workflow-builder/run-schema.ts`
**Sửa dòng 63-69**: Truyền `existingResults` vào `runSchemaDag`:

```typescript
      const blockResults = await runSchemaDag({
        schema: {
          ...schema,
          flow: block.map((n) => n.id),
          nodes: block.map((n) => ({ ...n })),
        },
        input,
        files,
        exec,
        existingResults: nodeResults, // 👈 TRUYỀN nodeResults hiện có
      });
      // Không cần Object.assign nữa — runSchemaDag mutate trực tiếp nodeResults
      // Object.assign(nodeResults, blockResults); // ❌ XÓA dòng này
      i = j;
```

### Kiểm tra
- Test hiện tại `'runs nodes and calls completeWorkflow'` vẫn pass
- Thêm test mới: workflow có 3 blocks (connector → human → connector) → binding cross-block vẫn resolve

---

## Fix 3: API endpoint cho schema-driven workflow ⚡P0

### Vấn đề
Không có API nào cho phép trigger schema-driven workflow bằng slug. API `/api/v1/docs/workflows` chỉ biết 3 subCases hardcode trong `SERVICE_REGISTRY`.

### Giải pháp
Tạo API mới: `POST /api/v1/docs/workflows/schema` nhận slug + input + files, tự động load schema từ DB, enqueue job.

### File mới: `app/api/v1/docs/workflows/schema/route.ts`

```typescript
// app/api/v1/docs/workflows/schema/route.ts
// Trigger a schema-driven workflow by slug.
// POST /api/v1/docs/workflows/schema
//   FormData: schemaSlug (string), input (JSON string), files (optional)
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { normalizeFiles, apiError } from '@/lib/endpoints/runner';
import { submitPipelineJob } from '@/lib/pipelines/submit';
import { loadSchema } from '@/lib/workflow-builder/loader';
import { validateSchema } from '@/lib/workflow-builder/interpreter';
import { db } from '@/lib/db';
import { apiKeys } from '@/lib/db/schema';
import { eq, asc } from 'drizzle-orm';

export async function POST(req: NextRequest) {
  const correlationId = req.headers.get('x-correlation-id') || crypto.randomUUID();
  try {
    const form = await req.formData();
    const schemaSlug = (form.get('schemaSlug') as string | null)?.trim();
    if (!schemaSlug) {
      return apiError(400, 'Missing Parameter', 'Field "schemaSlug" is required.');
    }

    // Load schema từ DB
    const schema = await loadSchema(schemaSlug);
    if (!schema) {
      return apiError(404, 'Schema Not Found', `Workflow schema '${schemaSlug}' not found. Import it first.`);
    }

    // Validate
    const errors = validateSchema(schema);
    if (errors.length > 0) {
      return apiError(400, 'Invalid Schema', `Schema '${schemaSlug}' is invalid: ${errors.join('; ')}`);
    }

    // Files
    const files = normalizeFiles(form);

    // Input variables
    const inputRaw = form.get('input') as string | null;
    let input: Record<string, unknown> = {};
    if (inputRaw) {
      try { input = JSON.parse(inputRaw); } catch {
        return apiError(400, 'Invalid Input', 'Field "input" must be valid JSON.');
      }
    }

    // Build pipeline với schemaSlug
    const pipeline = [{
      processor: '__schema__',
      variables: { schemaSlug, ...input },
    }];

    const endpointSlug = `workflows:${schemaSlug}`;

    // API Key
    let apiKeyId = form.get('apiKeyId') as string | null;
    if (apiKeyId) {
      let existingKey = null;
      try { [existingKey] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKeyId)).limit(1); } catch {}
      if (!existingKey) {
        const computedHash = crypto.createHash('sha256').update(apiKeyId).digest('hex');
        try { [existingKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, computedHash)).limit(1); } catch {}
      }
      if (!existingKey) {
        return apiError(400, 'Invalid Profile API Key', 'API Key không tồn tại.');
      }
      apiKeyId = existingKey.id;
    }
    if (!apiKeyId) {
      const [adminKey] = await db.select().from(apiKeys).where(eq(apiKeys.role, 'ADMIN')).orderBy(asc(apiKeys.createdAt)).limit(1);
      apiKeyId = adminKey?.id || null;
    }

    const result = await submitPipelineJob({
      pipeline,
      files,
      endpointSlug,
      correlationId,
      apiKeyId: apiKeyId || undefined,
      disableHistory: false,
    });

    if (!result.ok) return result.errorResponse;

    return NextResponse.json({
      name: `operations/${result.operation.id}`,
      done: false,
      metadata: {
        state: 'RUNNING',
        workflow: schemaSlug,
        progress_percent: 0,
        progress_message: 'Initializing schema workflow...',
      },
    }, {
      status: 202,
      headers: { 'Operation-Location': `/api/v1/operations/${result.operation.id}` },
    });
  } catch (err: any) {
    return apiError(500, 'Internal Workflow Error', err.message);
  }
}
```

### File: `lib/pipelines/workflow-engine.ts`
**Sửa `runWorkflow`** (dòng ~414-427): Xử lý trường hợp schema-driven:

```typescript
export async function runWorkflow(
  operationId: string,
  correlationId?: string,
  job?: Job,
): Promise<void> {
  const ctx = await createWorkflowContext(operationId, correlationId, job);
  if (!ctx) return;

  const jobName = job?.name || '';
  const workflowNameRaw = jobName.replace('pipeline:workflows:', '');
  const workflowName = workflowNameRaw.split(' ')[0];

  // 👇 SPECIAL CASE: schema-driven workflow
  // Khi đến từ POST /api/v1/docs/workflows/schema, pipeline[0].processor = '__schema__'
  // và variables.schemaSlug chứa slug thật
  if (ctx.pipelineVars.schemaSlug) {
    const schemaSlug = String(ctx.pipelineVars.schemaSlug);
    ctx.logger.info(`[WORKFLOW] Schema-driven workflow: '${schemaSlug}'`);
    const schema = await loadSchema(schemaSlug);
    if (schema) {
      await runWorkflowFromSchema(ctx, schema);
      return;
    }
    await failWorkflow(ctx, new Error(`Schema '${schemaSlug}' not found in DB.`));
    return;
  }

  const handler = WORKFLOW_REGISTRY[workflowName];
  if (!handler) {
    ctx.logger.error(`[WORKFLOW] Unknown workflow: '${workflowName}'`);
    const schema = await loadSchema(workflowName);
    if (schema) {
      await runWorkflowFromSchema(ctx, schema);
      return;
    }
    await failWorkflow(ctx, new Error(`Unknown workflow: '${workflowName}'`));
  } else {
    try {
      await handler(ctx);
    } catch (error) {
      await failWorkflow(ctx, error);
    }
  }
}
```

### Kiểm tra
- Gọi `POST /api/v1/docs/workflows/schema` với `schemaSlug=disbursement` + files → tạo Operation → worker chạy schema
- Gọi với slug không tồn tại → 404

---

## Fix 4: Resume HITL — persist nodeResults ⚡P1

### Vấn đề
Khi workflow pause ở `human` node, `nodeResults` không được lưu vào DB. Khi resume, `runWorkflowFromSchema` khởi tạo `nodeResults = {}` → binding sai.

### File: `lib/workflow-builder/run-schema.ts`
**Sửa**: Lưu nodeResults vào `stepsResultJson` và khôi phục khi resume.

**Dòng 28-37**: Thêm khôi phục nodeResults từ context:

```typescript
export async function runWorkflowFromSchema(
  ctx: WorkflowContext,
  schema: WorkflowSchema,
): Promise<void> {
  const errors = validateSchema(schema);
  if (errors.length > 0) {
    await failWorkflow(ctx, new Error(`Invalid schema '${schema.slug}': ${errors.join('; ')}`));
    return;
  }

  const input: Record<string, unknown> = { ...ctx.pipelineVars };
  const files: string[] = (ctx.filesData ?? []).map((f) => f.path).filter(Boolean);
  const exec = buildExecFunc(ctx);

  const totalSteps = schema.flow.length;
  const ordered = schema.flow
    .map((id) => schema.nodes.find((n) => n.id === id))
    .filter((n): n is NonNullable<typeof n> => !!n);

  // 👇 Khôi phục nodeResults từ ctx nếu có (resume sau HITL)
  const nodeResults: Record<string, NodeResult> = {};
  const savedNodeResults = (ctx as any)._nodeResults;
  if (savedNodeResults && typeof savedNodeResults === 'object') {
    Object.assign(nodeResults, savedNodeResults);
  }
  const startIndex = ctx.currentStep ?? 0;
```

**Sửa dòng 45-49**: Lưu nodeResults vào ctx trước khi pause:

```typescript
      if (node.type === 'human') {
        // Lưu nodeResults vào context để resume
        (ctx as any)._nodeResults = nodeResults;
        await updateProgress(ctx, Math.round((i / totalSteps) * 100), node.message);
        await pauseWorkflow(ctx, node.message, i + 1);
        return; // halted until resume
      }
```

### File: `lib/pipelines/workflow-engine.ts`
**Sửa `pauseWorkflow`** (dòng 245): Lưu nodeResults JSON vào `stepsResultJson`:

```typescript
export async function pauseWorkflow(ctx: WorkflowContext, message: string, currentStep: number) {
  let stepsResultJson = JSON.stringify(ctx.stepsResult);
  // 👇 Embed nodeResults vào stepsResult dưới dạng metadata
  const nodeResults = (ctx as any)._nodeResults;
  if (nodeResults) {
    const payload = { stepsResult: ctx.stepsResult, _nodeResults: nodeResults };
    stepsResultJson = JSON.stringify(payload);
  }
  
  await db.update(operations).set({
    done: false,
    state: 'WAITING_USER_INPUT',
    progressMessage: message,
    currentStep,
    stepsResultJson,
    totalInputTokens: ctx.totalInputTokens,
    totalOutputTokens: ctx.totalOutputTokens,
    totalCostUsd: ctx.totalCost,
  }).where(eq(operations.id, ctx.operationId));
  // ...
}
```

**Sửa `createWorkflowContext`** (dòng 375): Khôi phục nodeResults:

```typescript
  let stepsResult: WorkflowStepResult[] = [];
  let _nodeResults: any = null;
  if (operation.stepsResultJson) {
    try {
      const parsed = JSON.parse(operation.stepsResultJson);
      // Kiểm tra nếu là format mới (có _nodeResults)
      if (parsed._nodeResults) {
        stepsResult = parsed.stepsResult;
        _nodeResults = parsed._nodeResults;
      } else {
        stepsResult = parsed;
      }
    } catch {
      stepsResult = [];
    }
  }

  return {
    operationId,
    // ... các field khác giữ nguyên
    stepsResult,
    _nodeResults, // 👈 THÊM
    currentStep: operation.currentStep,
  };
```

> **Lưu ý**: `WorkflowContext` cần thêm field `_nodeResults?: any` hoặc cast `(ctx as any)`.

### Kiểm tra
- Test resume: pause → lưu nodeResults → resume → nodeResults khôi phục → binding hoạt động

---

## Fix 5: Nút "Chạy thử" — thay 404 bằng gọi API ⚡P1

### Vấn đề
- Nút trong list/grid: `router.push('/workflow-builder/run?slug=X')` → 404
- Nút trong DetailView: gọi sai API contract

### File: `app/workflow-builder/page.tsx`

**Sửa tất cả nút "Chạy thử"**:

Thay vì `router.push('/workflow-builder/run?slug=...')`, gọi trực tiếp API mới:

```typescript
// Thêm hàm runSchema ở đầu component
async function runSchema(slug: string) {
  try {
    const res = await fetch(`/api/v1/docs/workflows/schema`, {
      method: 'POST',
      body: (() => {
        const fd = new FormData();
        fd.append('schemaSlug', slug);
        return fd;
      })(),
    });
    if (res.ok) {
      const data = await res.json();
      toast.success('Workflow đã khởi chạy');
      // Mở trang operation detail
      window.open(`/operations/${data.name.replace('operations/', '')}`, '_blank');
    } else {
      const { detail } = await res.json();
      toast.error(detail || 'Chạy thất bại');
    }
  } catch {
    toast.error('Lỗi kết nối');
  }
}
```

**Sửa `WorkflowDetailView` `handleRun`** (dòng 338-356):

```typescript
const handleRun = async () => {
  setRunLoading(true);
  setRunResult(null);
  try {
    const fd = new FormData();
    fd.append('schemaSlug', schema.slug);
    // Nếu có input_schema, thu thập từ form (hiện tại input rỗng)
    const res = await fetch('/api/v1/docs/workflows/schema', {
      method: 'POST',
      body: fd,
    });
    const data = await res.json();
    setRunResult(data);
    if (res.ok) toast.success('Workflow đã khởi chạy');
    else toast.error(data.detail || data.error || 'Chạy thất bại');
  } catch {
    toast.error('Lỗi kết nối');
  } finally {
    setRunLoading(false);
  }
};
```

### Kiểm tra
- Click "Chạy thử" → gọi API → tạo Operation → redirect (hoặc hiển thị operationId)

---

## Fix 6: XML converter — auth fields ⚡P2

### Vấn đề
`file_url_download` và `callback` trong XML không parse được `auth` config.

### File: `lib/workflow-builder/xml-converter.ts`
**Sửa case `file_url_download`**:

```typescript
      case 'file_url_download': {
        base.urls = rawNode['@_urls'] ?? '$input.urls';
        if (rawNode['@_allowedExtensions']) base.allowedExtensions = rawNode['@_allowedExtensions'];
        // Parse auth block
        if (rawNode.auth) {
          const auth: any = {};
          const a = rawNode.auth;
          if (a['@_type']) auth.type = a['@_type'];
          if (a['@_token']) auth.token = a['@_token'];
          if (a['@_header_name']) auth.header_name = a['@_header_name'];
          if (a['@_header_value']) auth.header_value = a['@_header_value'];
          if (a['@_query_key']) auth.query_key = a['@_query_key'];
          if (a['@_query_value']) auth.query_value = a['@_query_value'];
          base.auth = auth;
        }
        nodes.push(base);
        break;
      }
```

**Sửa case `callback`**:

```typescript
      case 'callback': {
        base.url = rawNode['@_url'];
        base.method = (rawNode['@_method'] ?? 'POST').toUpperCase();
        if (rawNode['@_payload']) base.payload = rawNode['@_payload'];
        // Parse auth block
        if (rawNode.auth) {
          const auth: any = {};
          const a = rawNode.auth;
          if (a['@_type']) auth.type = a['@_type'];
          if (a['@_token']) auth.token = a['@_token'];
          if (a['@_header_name']) auth.header_name = a['@_header_name'];
          if (a['@_header_value']) auth.header_value = a['@_header_value'];
          if (a['@_query_key']) auth.query_key = a['@_query_key'];
          if (a['@_query_value']) auth.query_value = a['@_query_value'];
          base.auth = auth;
        }
        nodes.push(base);
        break;
      }
```

**Sửa `nodeToXml`**: Thêm serialization auth:

```typescript
function nodeToXml(n: WorkflowNode): any {
  const anyNode = n as any;
  const out: any = { '@_id': n.id, '@_type': n.type };
  if (anyNode.connector) out['@_connector'] = anyNode.connector;
  if (anyNode.promptOverrideKey) out['@_promptOverrideKey'] = anyNode.promptOverrideKey;
  if (anyNode.message) out['@_message'] = anyNode.message;
  if (anyNode.source) out['@_source'] = typeof anyNode.source === 'string' ? anyNode.source : JSON.stringify(anyNode.source);
  if (anyNode.connector && anyNode.inputs) {
    out.input = Object.entries(anyNode.inputs).map(([k, v]) => ({
      '@_key': k,
      '@_value': typeof v === 'string' ? v : JSON.stringify(v),
    }));
  }
  if (anyNode.branches) {
    out.branch = anyNode.branches.map((b: WorkflowNode[]) => ({ node: b.map(nodeToXml) }));
  }
  // 👇 Auth serialization cho file_url_download và callback
  if (anyNode.auth) {
    const a = anyNode.auth;
    out.auth = { '@_type': a.type };
    if (a.token) out.auth['@_token'] = a.token;
    if (a.header_name) out.auth['@_header_name'] = a.header_name;
    if (a.header_value) out.auth['@_header_value'] = a.header_value;
    if (a.query_key) out.auth['@_query_key'] = a.query_key;
    if (a.query_value) out.auth['@_query_value'] = a.query_value;
  }
  return out;
}
```

### Kiểm tra
- XML `<node id="dl" type="file_url_download" urls="$input.urls"><auth type="bearer" token="$input.token"/></node>` → parse đúng auth
- Round-trip: JSON → XML → JSON → auth giữ nguyên

---

## Fix 7: XML converter — maxTotalBytes/maxEntries ⚡P2

### Vấn đề
`archive_extract` trong XML không parse được `maxTotalBytes` và `maxEntries`.

### File: `lib/workflow-builder/xml-converter.ts`
**Sửa case `archive_extract`**:

```typescript
      case 'archive_extract': {
        base.source = rawNode['@_source'];
        if (rawNode['@_maxTotalBytes']) base.maxTotalBytes = Number(rawNode['@_maxTotalBytes']);
        if (rawNode['@_maxEntries']) base.maxEntries = Number(rawNode['@_maxEntries']);
        if (rawNode['@_destName']) base.destName = rawNode['@_destName'];
        nodes.push(base);
        break;
      }
```

**Sửa `nodeToXml`**: Thêm serialization:

```typescript
  if (anyNode.maxTotalBytes) out['@_maxTotalBytes'] = anyNode.maxTotalBytes;
  if (anyNode.maxEntries) out['@_maxEntries'] = anyNode.maxEntries;
  if (anyNode.destName) out['@_destName'] = anyNode.destName;
```

### Kiểm tra
- XML `<node id="unzip" type="archive_extract" source="$files" maxTotalBytes="52428800" maxEntries="500"/>` → parse đúng

---

## Fix 8: UI DetailView — lỗi hiển thị Nodes count ⚡P3

### Vấn đề
JSX `Nodes ({schema.nodes.length})` hiển thị nguyên văn dấu `{` do template literal sai.

### File: `app/workflow-builder/page.tsx`
**Dòng 383**: Sửa:

```typescript
{/* Trước: */}
<SchemaInfoCard title={Nodes ({schema.nodes.length})} icon={Zap}>

{/* Sau: */}
<SchemaInfoCard title={`Nodes (${schema.nodes.length})`} icon={Zap}>
```

### Kiểm tra
- DetailView hiển thị "Nodes (5)" thay vì "Nodes ({schema.nodes.length})"

---

## Fix 9: Cập nhật tests ⚡P1

### File: `tests/workflow-builder/run-schema.test.ts`

**Thêm các test case mới**:

```typescript
it('resolves cross-block bindings (human node in between)', async () => {
  // Workflow: node_a → human → node_b (node_b dùng $a.content)
  const crossBlockSchema: WorkflowSchema = {
    slug: 'cross-block',
    name: 'Cross Block',
    flow: ['a', 'human_step', 'b'],
    nodes: [
      { id: 'a', type: 'connector', connector: 'ext-classifier', inputs: { file: '$files' } },
      { id: 'human_step', type: 'human', message: 'Check?' },
      { id: 'b', type: 'connector', connector: 'ext-content-gen', inputs: { text: '$a.content' } },
    ],
    output: { from: 'b' },
  };

  // Run lần 1: chạy đến human_step
  mockPause.mockResolvedValue(undefined);
  await runWorkflowFromSchema(makeCtx(), crossBlockSchema);
  expect(mockPause).toHaveBeenCalled();
  expect(mockComplete).not.toHaveBeenCalled();
  expect(mockEnqueue).toHaveBeenCalledTimes(1); // chỉ node_a chạy

  // Mock resume: ctx.currentStep = 2, có nodeResults từ lần 1
  jest.clearAllMocks();
  mockEnqueue.mockResolvedValue({ content: 'Result from B', operation: { id: 'sub2' }, extractedData: null });
  const resumeCtx = makeCtx({
    currentStep: 2, // index của 'b'
    _nodeResults: {
      a: { nodeId: 'a', type: 'connector', content: 'Extracted Text', data: {}, output: 'Extracted Text' },
      human_step: { nodeId: 'human_step', type: 'human', data: { message: 'Check?' }, output: null },
    },
  });
  await runWorkflowFromSchema(resumeCtx, crossBlockSchema);
  expect(mockEnqueue).toHaveBeenCalledTimes(1);
  // Kiểm tra binding $a.content được resolve thành 'Extracted Text'
  const callArgs = mockEnqueue.mock.calls[0];
  expect(callArgs[2]).toMatchObject({ text: 'Extracted Text' });
  expect(mockComplete).toHaveBeenCalled();
});
```

### Kiểm tra
```bash
npx jest tests/workflow-builder --no-coverage
# Kết quả: tất cả pass
```

---

## Fix 10: Cập nhật docs/workflow-schema-guide.md

### Vấn đề
Guide cần cập nhật thông tin về API mới và cách chạy schema-driven workflow.

### Bổ sung vào `docs/workflow-schema-guide.md`
Thêm section mới sau section 8 (API Import Reference):

```markdown
## 8b. API chạy Schema-driven Workflow

### Trigger bằng slug
```
POST /api/v1/docs/workflows/schema
Content-Type: multipart/form-data

schemaSlug: "disbursement"
files: (optional) file đính kèm
input: (optional) JSON string chứa biến đầu vào
```

### Response
```json
{
  "name": "operations/<uuid>",
  "done": false,
  "metadata": {
    "state": "RUNNING",
    "workflow": "disbursement",
    "progress_percent": 0,
    "progress_message": "Initializing schema workflow..."
  }
}
```

Poll operation status tại: `GET /api/v1/operations/<uuid>`
```

---

## ⏱ Tổng quan effort

| Fix | File | Effort | Dependencies |
|-----|------|--------|-------------|
| 1 | `page.tsx` | 30 ph | — |
| 2 | `interpreter.ts`, `run-schema.ts` | 1 giờ | — |
| 3 | `schema/route.ts` (new), `workflow-engine.ts` | 3 giờ | Fix 2 |
| 4 | `run-schema.ts`, `workflow-engine.ts` | 2 giờ | Fix 2, 3 |
| 5 | `page.tsx` | 1 giờ | Fix 3 |
| 6 | `xml-converter.ts` | 30 ph | — |
| 7 | `xml-converter.ts` | 15 ph | — |
| 8 | `page.tsx` | 5 ph | — |
| 9 | `run-schema.test.ts` | 1 giờ | Fix 2, 4 |
| 10 | `workflow-schema-guide.md` | 15 ph | Fix 3 |

**Tổng**: ~10 giờ, 10 files (1 file mới, 9 file sửa)

---

## 📋 Thứ tự thực hiện đề xuất

```
Step 1: Fix 8 (5 ph) — UI lỗi hiển thị, dễ nhất
Step 2: Fix 6 + 7 (45 ph) — XML converter
Step 3: Fix 1 (30 ph) — UI Import
Step 4: Fix 2 (1 giờ) — Core engine
Step 5: Fix 4 (2 giờ) — Resume HITL
Step 6: Fix 3 (3 giờ) — API mới
Step 7: Fix 5 (1 giờ) — UI Chạy thử
Step 8: Fix 9 (1 giờ) — Tests
Step 9: Fix 10 (15 ph) — Docs
```

**Luồng kiểm tra cuối cùng**:
1. Import schema file `.json` qua UI → ✅
2. Vào DetailView → thấy Nodes count đúng → ✅
3. Click "Chạy thử" → API gọi, worker chạy schema → ✅
4. Workflow có HITL → pause → resume → binding vẫn hoạt động → ✅
5. XML import → auth fields parse đúng → ✅
6. `npx jest tests/workflow-builder` → tất cả pass → ✅
