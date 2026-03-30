'use strict';
// prisma/seed-additions.cjs
// CommonJS seed script — chạy được trong Docker runner (không cần tsx)
// CMD: node ./prisma/seed-additions.cjs
// Được gọi tự động khi container khởi động (trước node server.js)

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PDF_DOCX_MIMES =
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ─── Processors cần upsert khi deploy ──────────────────────────────────────
// Danh sách này là delta — chỉ chứa processors mới/cập nhật.
// Idempotent: an toàn chạy nhiều lần.

const ADDITIONAL_PROCESSORS = [
  {
    slug: 'prebuilt-fact-check',
    displayName: 'Kiểm tra & Đối chiếu Nội dung (Fact-Check)',
    type: 'PREBUILT',
    category: 'analyze',
    description:
      'Kiểm tra và đối chiếu nội dung tài liệu với dữ liệu tham chiếu theo các quy tắc nghiệp vụ tùy chỉnh. Trả về kết quả PASS/FAIL/WARNING cho từng điều khoản kiểm tra kèm giải thích chi tiết.',
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
    state: 'ENABLED',
  },
];

async function main() {
  console.log('🌱 [seed-additions] Seeding additional processors...');
  for (const proc of ADDITIONAL_PROCESSORS) {
    await prisma.processor.upsert({
      where: { slug: proc.slug },
      update: proc,
      create: proc,
    });
    console.log(`  ✅ ${proc.slug}`);
  }
  console.log(`\n🎉 [seed-additions] Done. ${ADDITIONAL_PROCESSORS.length} processors upserted.`);
}

main()
  .catch((err) => {
    console.error('[seed-additions] Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
