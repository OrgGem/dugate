# Business Requirements Document (BRD) — Action: Generate

- **Action Name**: `generate`
- **Business**: `document-core`
- **Specification Version**: 1.0.0
- **Test Catalog Suite**: `DOC-05`
- **Subcases / Variants**: 6 (`summary`, `outline`, `report`, `email`, `minutes`, `qa`)

---

## 1. Overview & Business Intent
The `generate` action synthesizes new derivative content from documents. It supports high-density executive summaries, hierarchical tables of contents (outlines), in-depth professional reports, polite customer service/sales email responses, structured meeting minutes with action item registers, and grounded question answering (QA) with evidence citations.

---

## 2. Actors & Triggers
- **API Client**: POST to `/api/v1/docs/generate` with document context and `task` discriminator.
- **Automated Workflow**: Drafting meeting follow-ups from transcripts, synthesizing multi-page reports into executive briefings.

---

## 3. Preconditions & Input Constraints
1. **Document Payload**: Either `artifactIds` or direct inline `text` must be supplied.
2. **Discriminator**: `task` parameter is mandatory and must be one of `['summary', 'outline', 'report', 'email', 'minutes', 'qa']`.
3. **Task-Specific Mandatory Inputs**:
   - `qa`: Requires `questions` (non-empty array or string with 1 to 20 questions).
4. **Format & Length Controls**: Optional `format` (`paragraph`, `bullets`, `numbered`, `table`) and `maxWords` caps.

---

## 4. Variant Inventory (6 Variants)

### 4.1. `task: summary` (Document Summarization)
- **Connector Slot**: `reasoning`
- **Function**: Condenses extensive documents down to essential themes, key statistics, and conclusions, adhering to `maxWords` and requested `format`.
- **Output**: `SummaryResult`: summaryText, keyTakeaways array, compressionRatio.

### 4.2. `task: outline` (Hierarchical Table of Contents & Structure)
- **Connector Slot**: `reasoning`
- **Function**: Extracts the logical hierarchy of a document into a structured outline tree (H1, H2, H3) with page/section references where identifiable.
- **Output**: `OutlineResult`: outlineItems array (level, title, summary, sectionIndex).

### 4.3. `task: report` (Professional Analytical Report Synthesis)
- **Connector Slot**: `reasoning`
- **Function**: Transforms raw data, findings, or narratives into a structured analytical report written for a target `audience` with professional domain commentary.
- **Output**: `ReportResult`: reportTitle, executiveSummary, bodySections array (heading, content, tables), recommendations array.

### 4.4. `task: email` (Correspondence & Draft Response)
- **Connector Slot**: `reasoning`
- **Function**: Generates contextual email responses (e.g. responding to customer complaints or client inquiries) with selectable `tone` (`formal`, `casual`, `business`).
- **Output**: `EmailResult`: subject, salutation, bodyParagraphs, callToAction, signOff.

### 4.5. `task: minutes` (Meeting Minutes & Action Item Extraction)
- **Connector Slot**: `reasoning`
- **Function**: Parses transcripts or rough meeting notes into structured minutes, identifying attendees, discussion topics, decisions made, and an action items register.
- **Output**: `MinutesResult`: meetingTopic, attendees, keyDecisions, actionItems array (assignee, taskDescription, deadline).

### 4.6. `task: qa` (Grounded Document Question Answering)
- **Connector Slot**: `reasoning`
- **Function**: Answers specific factual questions strictly based on the source document, providing verbatim evidence citations and confidence metrics.
- **Output**: `QAResult`: answers array (question, answer, evidenceQuote, confidence).

---

## 5. Execution Flows

### 5.1. Happy Path Flow
1. **Validate Input**: Validates presence of `task`, checks presence of source text/artifacts, validates `questions` presence for `qa`.
2. **Select Recipe**: Selects generation prompt recipe corresponding to `task`, applies system safety instructions, sets temperature and word constraints.
3. **Prepare Sources**: Reads document text using `document-kit` parser or direct text stream.
4. **Execute Recipe**:
   - `build-prompt`: Combines source text, target task guidelines, audience, format, and questions.
   - `connector-inference`: Dispatches request to Connector slot `reasoning`.
   - `validate-structure`: Validates that the provider output satisfies the variant's schema.
5. **Format Result**: Builds `GenerationEnvelope`, writes full output checkpoint (>500 chars guaranteed intact), and persists output artifact.

### 5.2. Error & Alternative Flows
- **E01 (Missing Questions in QA)**: `qa` invoked without `questions` -> 422 `MISSING_REQUIRED_PARAMETER`.
- **E02 (Questions List Too Large)**: `questions` array exceeds 20 items -> 422 `LIMIT_EXCEEDED`.
- **E03 (Negative Max Words)**: `maxWords <= 0` -> 422 `INVALID_ARGUMENT`.
- **E04 (Empty Document)**: Empty string or zero-length document provided -> 422 `EMPTY_DOCUMENT`.

---

## 6. Field Dictionary

| Parameter | Type | Required? | Allowed Values / Format | Description |
|---|---|---|---|---|
| `task` | string | Yes | `'summary'`, `'outline'`, `'report'`, `'email'`, `'minutes'`, `'qa'` | Generation variant discriminator. |
| `artifactIds` | string[] | No | UUID array | Input document artifact references. |
| `text` | string | No | String | Direct document text payload. |
| `format` | string | No | `'paragraph'`, `'bullets'`, `'numbered'`, `'table'` | Output presentation layout. |
| `maxWords` | integer | No | Positive integer (50 - 50,000) | Maximum word count cap. |
| `tone` | string | No | `'formal'`, `'casual'`, `'business'`, `'academic'` | Tone of voice. |
| `audience` | string | No | String (e.g. `"Executives"`, `"Clients"`) | Intended reader profile. |
| `questions` | string[] \| string | Conditional | Array of questions or newline-separated | Mandatory for `task === 'qa'`. |

---

## 7. Sample Payloads & Expected Results

### 7.1. Sample Input (`task: qa`)
```json
{
  "task": "qa",
  "text": "The lease agreement commenced on January 1, 2026. The monthly rental amount is $3,500 due on the 5th of each month. A security deposit of $7,000 is held in escrow.",
  "questions": [
    "What is the monthly rental amount?",
    "When is the rent due each month?"
  ]
}
```

### 7.2. Expected Result (`task: qa`)
```json
{
  "status": "COMPLETED",
  "data": {
    "answers": [
      {
        "question": "What is the monthly rental amount?",
        "answer": "$3,500 per month.",
        "evidenceQuote": "The monthly rental amount is $3,500",
        "confidence": 0.98
      },
      {
        "question": "When is the rent due each month?",
        "answer": "On the 5th of each month.",
        "evidenceQuote": "due on the 5th of each month.",
        "confidence": 0.99
      }
    ]
  },
  "provenance": {
    "method": "grounded_qa",
    "modelSlot": "reasoning"
  },
  "warnings": []
}
```

---

## 8. Profile Settings & Connector Slots
- **Connector Slot**: `reasoning` (required for all 6 variants).
- **Profile Overrides**:
  - Pinned email signatures and standard company tone policies.
  - Max token limits per generation variant.

---

## 9. Standard Function Signatures
```ts
export function validateInput(raw: unknown): Result<GenerateInput, ValidationError>;
export function selectRecipe(input: GenerateInput, profile: ProfileSnapshot): RecipeDefinition;
export function prepareSources(ctx: TaskContext, input: GenerateInput): Promise<NormalizedSources>;
export function executeRecipe(ctx: TaskContext, recipe: RecipeDefinition, sources: NormalizedSources): Promise<GenerateResult>;
export function validateResult(output: unknown, outputSchema: object): Result<GenerateResult, SchemaError>;
export function formatResult(ctx: TaskContext, result: GenerateResult, format: string): Promise<ResultEnvelope>;
```

---

## 10. Acceptance Tests Traceability

| Case ID | Scenario | Input | Expected Output |
|---|---|---|---|
| `DOC-05-v1` | Document summary | 10-page report text, `maxWords=100` | Concise summary under 100 words with bullet points |
| `DOC-05-v2` | Outline generation | Technical manual text | Hierarchical outline items with levels 1-3 |
| `DOC-05-v3` | Executive report | Raw sales data | Structured executive report with sections |
| `DOC-05-v4` | Email draft | Customer refund request | Professional apologetic email response |
| `DOC-05-v5` | Meeting minutes | Dialogue transcript | Structured decisions and action items with owners |
| `DOC-05-v6` | Question answering | Contract text + 2 questions | 2 grounded answers with exact evidence quotes |
| `DOC-05-ERR1` | Missing questions in QA | `{ "task": "qa", "text": "foo" }` | 422 `MISSING_REQUIRED_PARAMETER` |
| `DOC-05-ERR2` | Exceeded questions cap | 25 questions in array | 422 `LIMIT_EXCEEDED` |
