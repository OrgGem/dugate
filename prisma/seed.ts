// prisma/seed.ts
// Seed 10 prebuilt processors for Dugate Document AI

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PDF_DOCX_MIMES = 'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const PREBUILT_PROCESSORS = [
  {
    slug: 'prebuilt-layout',
    displayName: 'Chuyển đổi văn bản (PDF/DOCX → Markdown)',
    type: 'PREBUILT',
    category: 'extract',
    description: 'Chuyển đổi tài liệu PDF hoặc DOCX sang Markdown giữ nguyên cấu trúc bảng biểu, heading, và hình ảnh.',
    systemPrompt: 'Convert the document content to well-structured Markdown. Preserve all tables, headings, lists, and formatting.',
    responseSchema: null,
    acceptedMimes: PDF_DOCX_MIMES,
    outputFormats: 'md,html',
    variablesSchema: null,
    canBeFirstStep: true,
    canBeChainStep: false,
    processorConfig: JSON.stringify({ docxMode: 'ai', docxFormat: 'html', compressLevel: 'ebook' }),
  },
  {
    slug: 'prebuilt-invoice',
    displayName: 'Bóc tách dữ liệu Hóa đơn',
    type: 'PREBUILT',
    category: 'extract',
    description: 'Trích xuất dữ liệu từ hóa đơn VAT: số hóa đơn, người bán, tổng tiền, thuế.',
    systemPrompt: 'Extract structured data from this invoice document. Return JSON with fields: invoice_no, date, seller_name, seller_tax_code, buyer_name, items (array of {description, quantity, unit_price, amount}), subtotal, vat_amount, total_amount, currency.',
    responseSchema: JSON.stringify({
      type: 'object',
      properties: {
        invoice_no: { type: 'string' },
        date: { type: 'string' },
        seller_name: { type: 'string' },
        seller_tax_code: { type: 'string' },
        buyer_name: { type: 'string' },
        subtotal: { type: 'number' },
        vat_amount: { type: 'number' },
        total_amount: { type: 'number' },
        currency: { type: 'string' },
      },
    }),
    acceptedMimes: PDF_DOCX_MIMES,
    outputFormats: 'json',
    variablesSchema: null,
    canBeFirstStep: true,
    canBeChainStep: false,
    processorConfig: JSON.stringify({ docxMode: 'ai', docxFormat: 'html', compressLevel: 'ebook' }),
  },
  {
    slug: 'prebuilt-id-card',
    displayName: 'Bóc tách CCCD/CMND',
    type: 'PREBUILT',
    category: 'extract',
    description: 'Trích xuất thông tin từ ảnh/scan Căn cước công dân hoặc Chứng minh nhân dân.',
    systemPrompt: 'Extract structured data from this identity card document. Return JSON with fields: full_name, date_of_birth, gender, nationality, place_of_origin, place_of_residence, id_number, expiry_date.',
    responseSchema: JSON.stringify({
      type: 'object',
      properties: {
        full_name: { type: 'string' },
        date_of_birth: { type: 'string' },
        gender: { type: 'string' },
        id_number: { type: 'string' },
        place_of_origin: { type: 'string' },
        place_of_residence: { type: 'string' },
      },
    }),
    acceptedMimes: PDF_DOCX_MIMES + ',image/jpeg,image/png',
    outputFormats: 'json',
    variablesSchema: null,
    canBeFirstStep: true,
    canBeChainStep: false,
    processorConfig: null,
  },
  {
    slug: 'prebuilt-contract',
    displayName: 'Trích xuất điều khoản Hợp đồng',
    type: 'PREBUILT',
    category: 'extract',
    description: 'Trích xuất các điều khoản, bên ký kết, thời hạn, và cam kết từ hợp đồng.',
    systemPrompt: 'Extract structured data from this contract document. Return JSON with: parties (array), effective_date, expiry_date, key_clauses (array of {clause_number, title, summary}), penalties, total_value.',
    responseSchema: JSON.stringify({
      type: 'object',
      properties: {
        parties: { type: 'array', items: { type: 'string' } },
        effective_date: { type: 'string' },
        expiry_date: { type: 'string' },
        key_clauses: { type: 'array', items: { type: 'object' } },
        total_value: { type: 'string' },
      },
    }),
    acceptedMimes: PDF_DOCX_MIMES,
    outputFormats: 'json',
    variablesSchema: JSON.stringify({
      type: 'object',
      properties: {
        clauses_focus: { type: 'array', items: { type: 'string' }, description: 'Specific clauses to focus on' },
      },
    }),
    canBeFirstStep: true,
    canBeChainStep: false,
    processorConfig: JSON.stringify({ docxMode: 'ai', docxFormat: 'html' }),
  },
  {
    slug: 'prebuilt-summarize',
    displayName: 'Tóm tắt tài liệu',
    type: 'PREBUILT',
    category: 'generate',
    description: 'Tóm tắt nội dung tài liệu theo độ dài và phong cách yêu cầu.',
    systemPrompt: 'Summarize the following document content in {{max_words}} words or less. Write in a clear, professional tone. Preserve key facts and figures.\n\n---\n\n{{input_content}}',
    responseSchema: null,
    acceptedMimes: PDF_DOCX_MIMES,
    outputFormats: 'md',
    variablesSchema: JSON.stringify({
      type: 'object',
      properties: {
        max_words: { type: 'number', default: 500, description: 'Maximum words for summary' },
      },
    }),
    canBeFirstStep: true,
    canBeChainStep: true,
    processorConfig: JSON.stringify({ docxMode: 'ai', docxFormat: 'html', compressLevel: 'ebook' })
  },
  {
    slug: 'prebuilt-translate',
    displayName: 'Dịch thuật tài liệu',
    type: 'PREBUILT',
    category: 'generate',
    description: 'Dịch toàn bộ tài liệu sang ngôn ngữ đích, giữ nguyên cấu trúc Markdown.',
    systemPrompt: 'Translate the following document to {{target_language}}. Tone: {{tone}}. CRITICAL: Preserve ALL Markdown formatting including headings, tables, lists, bold, italic, and code blocks exactly as they are. Only translate the text content.\n\n---\n\n{{input_content}}',
    responseSchema: null,
    acceptedMimes: PDF_DOCX_MIMES,
    outputFormats: 'md,html',
    variablesSchema: JSON.stringify({
      type: 'object',
      required: ['target_language'],
      properties: {
        target_language: { type: 'string', description: 'Target language', examples: ['Tiếng Việt', 'English', 'Japanese'] },
        tone: { type: 'string', enum: ['formal', 'casual', 'technical'], default: 'formal' },
      },
    }),
    canBeFirstStep: true,
    canBeChainStep: true,
    processorConfig: JSON.stringify({ docxMode: 'ai', docxFormat: 'html', compressLevel: 'ebook' })
  },
  {
    slug: 'prebuilt-redact',
    displayName: 'Che mờ thông tin nhạy cảm (PII)',
    type: 'PREBUILT',
    category: 'generate',
    description: 'Nhận diện và thay thế thông tin cá nhân (tên, SĐT, email, số tài khoản) bằng placeholder.',
    systemPrompt: 'Redact all personally identifiable information (PII) from the following document. Replace names with [TÊN], phone numbers with [SĐT], emails with [EMAIL], bank accounts with [TK], ID numbers with [CCCD]. Preserve ALL formatting.\n\n---\n\n{{input_content}}',
    responseSchema: null,
    acceptedMimes: PDF_DOCX_MIMES,
    outputFormats: 'md',
    variablesSchema: JSON.stringify({
      type: 'object',
      properties: {
        pii_types: { type: 'array', items: { type: 'string' }, description: 'Specific PII types to redact' },
      },
    }),
    canBeFirstStep: true,
    canBeChainStep: true,
    processorConfig: JSON.stringify({ docxMode: 'ai', docxFormat: 'html' }),
  },
  {
    slug: 'prebuilt-compare',
    displayName: 'So sánh ngữ nghĩa 2 văn bản',
    type: 'PREBUILT',
    category: 'analyze',
    description: 'Phân tích sự khác biệt ngữ nghĩa giữa file gốc và file chỉnh sửa.',
    systemPrompt: 'Compare the following two documents semantically. Identify all changes: added, removed, and modified sections. For each change provide: type (added/removed/modified), section, original_text, changed_text, significance (low/medium/high), explanation.',
    responseSchema: JSON.stringify({
      type: 'object',
      properties: {
        similarity_score: { type: 'number' },
        total_changes: { type: 'number' },
        differences: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['added', 'removed', 'modified'] },
              section: { type: 'string' },
              original_text: { type: 'string' },
              changed_text: { type: 'string' },
              significance: { type: 'string' },
              explanation: { type: 'string' },
            },
          },
        },
      },
    }),
    acceptedMimes: PDF_DOCX_MIMES,
    outputFormats: 'json',
    variablesSchema: null,
    canBeFirstStep: true,
    canBeChainStep: false,
    processorConfig: JSON.stringify({ docxMode: 'ai', docxFormat: 'html', compressLevel: 'ebook' }),
  },
  {
    slug: 'prebuilt-classify',
    displayName: 'Phân loại tài liệu',
    type: 'PREBUILT',
    category: 'analyze',
    description: 'Tự động phân loại tài liệu thuộc loại gì: Hóa đơn, Hợp đồng, CV, Báo cáo...',
    systemPrompt: 'Classify this document. Return JSON with: document_type (one of: invoice, contract, resume, report, letter, form, regulation, other), confidence (0-1), language, page_count_estimate, key_topics (array of strings).',
    responseSchema: JSON.stringify({
      type: 'object',
      properties: {
        document_type: { type: 'string' },
        confidence: { type: 'number' },
        language: { type: 'string' },
        key_topics: { type: 'array', items: { type: 'string' } },
      },
    }),
    acceptedMimes: PDF_DOCX_MIMES,
    outputFormats: 'json',
    variablesSchema: JSON.stringify({
      type: 'object',
      properties: {
        labels: { type: 'array', items: { type: 'string' }, description: 'Custom classification labels' },
      },
    }),
    canBeFirstStep: true,
    canBeChainStep: true,
    processorConfig: JSON.stringify({ docxMode: 'ai', docxFormat: 'html' })
  },
  {
    slug: 'dynamic-genai',
    displayName: 'Dynamic GenAI (Admin Only)',
    type: 'PREBUILT',
    category: 'advanced',
    description: 'Processor tự do cho phép truyền prompt tùy ý. Yêu cầu API Key quyền ADMIN.',
    systemPrompt: '{{prompt}}',
    responseSchema: null,
    acceptedMimes: PDF_DOCX_MIMES,
    outputFormats: 'md,html,json',
    variablesSchema: JSON.stringify({
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Custom system prompt' },
        response_schema: { type: 'object', description: 'JSON Schema for structured output' },
      },
    }),
    canBeFirstStep: true,
    canBeChainStep: true,
    processorConfig: null
  },
  // ── Fact-check ───────────────────────────────────────────────────────────
  {
    slug: 'prebuilt-fact-check',
    displayName: 'Kiểm tra & Đối chiếu Nội dung (Fact-Check)',
    type: 'PREBUILT',
    category: 'analyze',
    description: 'Kiểm tra và đối chiếu nội dung tài liệu với dữ liệu tham chiếu theo các quy tắc nghiệp vụ tùy chỉnh. Trả về kết quả PASS/FAIL/WARNING cho từng điều khoản kiểm tra kèm giải thích chi tiết.',
    systemPrompt: `You are a professional document compliance and fact-checking auditor.

**TASK:** Verify the document content against the provided reference data, following the business rules specified below.

---

**BUSINESS RULES / CHECK CRITERIA:**
{{check_prompt}}

---

**REFERENCE DATA:**
{{reference_text}}

---

**DOCUMENT CONTENT:**
{{input_content}}

---

**Instructions:**
Carefully compare the document content against the reference data for each rule or criterion. For each check:
- Extract the exact value/statement from the document
- Compare it with the corresponding value in the reference data
- Assign a status: PASS (matches/compliant), FAIL (contradicts/non-compliant), WARNING (partially matches or ambiguous), NOT_APPLICABLE (rule doesn't apply to this document)

Return ONLY a valid JSON object with this exact structure (no markdown fences, no extra text outside JSON):
{
  "verdict": "PASS | FAIL | WARNING | INCONCLUSIVE",
  "score": <integer 0-100, overall compliance percentage>,
  "summary": "<2-3 sentence overall compliance assessment>",
  "checks": [
    {
      "rule": "<specific rule or criterion checked>",
      "status": "PASS | FAIL | WARNING | NOT_APPLICABLE",
      "document_value": "<exact value or text found in the document>",
      "reference_value": "<corresponding expected value from reference data>",
      "explanation": "<concise explanation of why this check passed or failed>"
    }
  ],
  "discrepancies": ["<list of key discrepancies found, each as a concise statement>"]
}`,
    responseSchema: JSON.stringify({
      type: 'object',
      required: ['verdict', 'score', 'summary', 'checks'],
      properties: {
        verdict: { type: 'string', enum: ['PASS', 'FAIL', 'WARNING', 'INCONCLUSIVE'] },
        score: { type: 'integer', minimum: 0, maximum: 100 },
        summary: { type: 'string' },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['rule', 'status', 'explanation'],
            properties: {
              rule: { type: 'string' },
              status: { type: 'string', enum: ['PASS', 'FAIL', 'WARNING', 'NOT_APPLICABLE'] },
              document_value: { type: 'string' },
              reference_value: { type: 'string' },
              explanation: { type: 'string' },
            },
          },
        },
        discrepancies: { type: 'array', items: { type: 'string' } },
      },
    }),
    acceptedMimes: PDF_DOCX_MIMES,
    outputFormats: 'json',
    variablesSchema: JSON.stringify({
      type: 'object',
      required: ['reference_text', 'check_prompt'],
      properties: {
        reference_text: {
          type: 'string',
          description: 'Dữ liệu tham chiếu để đối chiếu (văn bản thuần hoặc JSON string)',
        },
        check_prompt: {
          type: 'string',
          description: 'Quy tắc nghiệp vụ hoặc tiêu chí kiểm tra cụ thể',
        },
      },
    }),
    canBeFirstStep: true,
    canBeChainStep: true,
    processorConfig: JSON.stringify({ docxMode: 'ai', docxFormat: 'html', compressLevel: 'ebook' }),
  },
];


async function main() {
  console.log('🌱 Seeding processors...');

  for (const proc of PREBUILT_PROCESSORS) {
    await prisma.processor.upsert({
      where: { slug: proc.slug },
      update: { ...proc },
      create: { ...proc },
    });
    console.log(`  ✅ ${proc.slug}`);
  }

  console.log(`\n🎉 Seeded ${PREBUILT_PROCESSORS.length} processors.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
