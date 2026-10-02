# Business specification — document-core

Business ID `document-core`; initial version đề xuất `1.0.0`. Một worker deployment chứa sáu action. Những subcases dưới đây được inventory từ registry cũ, là phạm vi cần đặc tả/test chứ không chứng nhận chất lượng nghiệp vụ của hệ thống cũ.

## Action matrix

| Action | Discriminator và subcases | Inputs chính | Output business data | Step outline |
|---|---|---|---|---|
| ingest | mode: parse, ocr, digitize, split | artifacts, language, pages | Document content/layout hoặc split artifact list | validate → native parse hoặc OCR → normalize → store |
| extract | type: invoice, contract, id-card, receipt, table, custom | documents/text, fields/schema | Structured extraction + warnings/provenance | prepare → prompt → inference → schema validation |
| analyze | task: classify, sentiment, compliance, fact-check, quality, risk, summarize-eval | documents/text, categories/criteria/reference | Findings, classification/scores theo task schema | prepare → evaluate → validate → report |
| transform | action: convert, translate, rewrite, redact, template | documents/text, targetLanguage/style/template | Transformed content/artifacts | prepare → local convert hoặc inference → verify → format |
| generate | task: summary, outline, report, email, minutes, qa | documents/text, questions/audience/tone | Generated content theo task | prepare → generate → validate → format |
| compare | mode: diff, semantic, version | source+target roles, focus | Differences with references | prepare each → compare → normalize references |

Tổng cộng **31 subcases**: 4+6+7+5+6+3, khớp với manifest `document-core.manifest.ts` và [variant matrix](../businesses/document-core/docs/variant-matrix.md). Ba subcase ngoài phạm vi cũ 28 là `extract/id-card`, `analyze/fact-check`, `analyze/summarize-eval`; cả ba có handler, recipe, input normalizer và output validator trong source. Không suy ra một subcase chỉ từ comment trong source.

## Input conventions

Canonical action input dùng camelCase; compatibility facade map snake_case form fields. Discriminator `action` bên trong transform input khác action name `transform` trong API path; normalize thành internal `variant` trước build pipeline để tránh nhầm.

- `ingest`: file bắt buộc; MIME/extension allowlist; native parse khi có parser hợp lệ, scan cần OCR capability.
- `extract/analyze/transform/generate`: file hoặc text theo variant. Không tự trả native parsed content thay cho yêu cầu inference.
- `compare`: đúng hai logical sides `source` và `target`; mỗi side số file tối đa do profile quy định, v1 mặc định một file hoặc text mỗi side.
- Client không truyền direct provider endpoint, header, secret hoặc `_prompt` escape hatch. Prompt override là profile config validated và pin revision.
- Output format hỗ trợ matrix theo variant, không chấp nhận mọi format cho mọi action. P0 chốt JSON/Markdown/text trước; HTML/CSV và binary conversion phải có converter+test cụ thể.

## Common result model

`DocumentResult`: contentRef, page/section/block metadata nếu provider/parser cung cấp, source artifact IDs, provenance method, warnings. Không bịa bounding boxes/page references khi nguồn không có.

`ExtractionResult`: data theo versioned schema, evidence references khi có, missing/uncertain field warnings. `custom` yêu cầu schema hữu hạn được validate trước dispatch.

`AnalysisResult`: findings/labels/scores có schema riêng từng variant; phân biệt model assessment với quyết định nghiệp vụ cuối.

`TransformResult` và `GenerationResult`: contentRef, output format, optional metadata, warnings.

`ComparisonResult`: source/target refs, changes với location/evidence nếu có, summary; không tự coi hai output có semantic giống nhau là byte-equal.

## Pipeline definition và connector slots

PipelineDefinition là business-owned data: stable step ID, handler kind, allowed input/output mapping, capability slot, prompt key/revision, failure policy. Default linear recipes nằm trong worker. Profile có thể chọn recipe và override các tham số/slots đã khai báo; không đưa arbitrary executable step code vào Admin.

Slots ban đầu: `ocr`, `reasoning`; optional `vision` khi variant cần. Profile publish kiểm tra variant capabilities và binding thiếu. Local parse không tính provider usage. Inference result phải validate trước đánh dấu success.

Prompt resolution đề xuất: business bắt buộc cấu trúc/system guard; profile override trên phần được khai báo editable; input variables interpolate sau validation. Không tự kế thừa ưu tiên `_prompt > profile > default` của source cũ nếu làm profile mất kiểm soát. Khác biệt này phải ghi compatibility matrix.

## Function structure cho mỗi action

1. `validateInput(raw, schema, policy)` → typed input hoặc field errors.
2. `selectRecipe(input, profile)` → immutable recipe ID/revision.
3. `prepareSources(ctx, input)` → normalized document/artifact refs.
4. `executeRecipe(ctx, recipe, refs)` → checkpointed step outputs.
5. `validateResult(output, outputSchema)` → typed result/warnings.
6. `formatResult(ctx, result, format)` → ResultEnvelope refs.

`executeRecipe` phải sử dụng SDK; không đọc platform DB, không gọi provider trực tiếp, không import old `engine.ts`. Shared logic nằm trong business `src/pipelines`, document utilities nằm document-kit.

## Business documentation deliverables trước source

Mỗi action cần một BRD trong `businesses/document-core/docs/{action}.md` gồm: actor/trigger, preconditions, happy/alternative/error flows, field dictionary, variant matrix, sample inputs/results, profile settings, provider assumptions, acceptance tests. Viết BRD và case matrix cho cả sáu trước implement action đầu tiên.

## Acceptance

- Mỗi 31 variant có ít nhất valid input, invalid input, expected output schema, required capability và profile lock case.
- Six-action E2E chạy mock, artifacts và usage; native parse được kiểm bằng fixture nội dung thật.
- Provider malformed JSON không đánh dấu success; repair policy có budget giới hạn nếu được bật.
- Resume với output >500 ký tự giữ nguyên full input bước kế; duplicate task không thêm invocation đã success.
- Test chất lượng LLM thật là opt-in evaluation với corpus được cấp quyền, tách khỏi deterministic CI.
