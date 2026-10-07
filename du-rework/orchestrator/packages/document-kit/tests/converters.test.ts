import { DiffEngine } from '../src/converters/diff-engine';
import { PiiRedactor } from '../src/converters/pii-redactor';
import { TemplateEngine } from '../src/converters/template-engine';
import { FormatConverter } from '../src/converters/format-converter';
import { TextChunker } from '../src/converters/text-chunker';

describe('Document Converters & Local Engines', () => {
  describe('DiffEngine (DOC-06-v1)', () => {
    it('computes line-level additions, deletions, and equalities', () => {
      const source = 'Line 1\nLine 2\nLine 3';
      const target = 'Line 1\nLine 2 modified\nLine 3\nLine 4';

      const diff = DiffEngine.computeDiff(source, target);

      expect(diff.additionsCount).toBe(2); // 'Line 2 modified', 'Line 4'
      expect(diff.deletionsCount).toBe(1); // 'Line 2'
      expect(diff.unmodifiedCount).toBe(2); // 'Line 1', 'Line 3'
      expect(diff.unifiedDiff).toContain('+ Line 2 modified');
      expect(diff.unifiedDiff).toContain('- Line 2');
      expect(diff.unifiedDiff).toContain('+ Line 4');
    });

    it('identifies identical documents as zero changes', () => {
      const text = 'Alpha\nBeta\nGamma';
      const diff = DiffEngine.computeDiff(text, text);

      expect(diff.additionsCount).toBe(0);
      expect(diff.deletionsCount).toBe(0);
      expect(diff.unmodifiedCount).toBe(3);
    });
  });

  describe('PiiRedactor (DOC-04-v4)', () => {
    it('redacts email addresses and phone numbers', () => {
      const input = 'Contact john.doe@example.com or call (555) 123-4567 for info.';
      const result = PiiRedactor.redact(input);

      expect(result.redactedText).toBe(
        'Contact [REDACTED:EMAIL] or call [REDACTED:PHONE] for info.'
      );
      expect(result.countsByPattern['EMAIL']).toBe(1);
      expect(result.countsByPattern['PHONE']).toBe(1);
      expect(result.redactionsCount).toBe(2);
    });

    it('redacts 12-digit national IDs/CCCD', () => {
      const input = 'So CCCD: 012345678901 cua cong dan.';
      const result = PiiRedactor.redact(input);

      expect(result.redactedText).toContain('[REDACTED:NATIONAL_ID]');
      expect(result.countsByPattern['NATIONAL_ID']).toBe(1);
    });
  });

  describe('TemplateEngine (DOC-04-v5)', () => {
    it('interpolates single and nested placeholders', () => {
      const template = 'Hello {{customer.name}}, your balance is {{account.balance}} VND.';
      const variables = {
        customer: { name: 'Nguyen Van A' },
        account: { balance: '5,000,000' },
      };

      const result = TemplateEngine.render(template, variables);
      expect(result.rendered).toBe('Hello Nguyen Van A, your balance is 5,000,000 VND.');
      expect(result.missingVariables).toEqual([]);
    });

    it('flags missing variables gracefully without crashing', () => {
      const template = 'Welcome {{user}}, your code is {{code}}.';
      const variables = { user: 'Admin' };

      const result = TemplateEngine.render(template, variables);
      expect(result.rendered).toBe('Welcome Admin, your code is {{code}}.');
      expect(result.missingVariables).toEqual(['code']);
    });
  });

  describe('FormatConverter (DOC-04-v1)', () => {
    it('converts markdown to basic HTML', () => {
      const md = '# Header 1\n\nSome paragraph text.';
      const html = FormatConverter.convertText(md, 'md', 'html');

      expect(html).toContain('<h1>Header 1</h1>');
      expect(html).toContain('<p>Some paragraph text.</p>');
    });

    it('strips markdown formatting to plain text', () => {
      const md = '## Title\n\nThis is **bold** and *italic* with `code`.';
      const text = FormatConverter.stripFormatting(md);

      expect(text).toBe('Title\n\nThis is bold and italic with code.');
    });
  });

  describe('TextChunker (DOC-04 Bounded Chunking)', () => {
    it('returns empty array for empty or whitespace-only text', () => {
      expect(TextChunker.splitIntoChunks('')).toEqual([]);
      expect(TextChunker.splitIntoChunks('   ')).toEqual([]);
    });

    it('returns single chunk when text is shorter than maxChunkSize', () => {
      const text = 'Short document content.';
      const chunks = TextChunker.splitIntoChunks(text, 100);
      expect(chunks).toEqual([text]);
    });

    it('splits long text on paragraph boundaries without dropping tail content', () => {
      const p1 = 'A'.repeat(60);
      const p2 = 'B'.repeat(60);
      const p3 = 'C'.repeat(60);
      const tail = 'TAIL_SENTINEL_CONTENT_123';
      const text = `${p1}\n\n${p2}\n\n${p3}\n\n${tail}`;

      const chunks = TextChunker.splitIntoChunks(text, 100);
      expect(chunks.length).toBeGreaterThan(1);
      // Verify tail content is present in the final chunk
      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk).toContain(tail);
      // Verify all paragraph contents are present across chunks
      expect(chunks.some((c) => c.includes(p1))).toBe(true);
      expect(chunks.some((c) => c.includes(p2))).toBe(true);
      expect(chunks.some((c) => c.includes(p3))).toBe(true);
    });

    it('handles long continuous text without break delimiters', () => {
      const text = 'X'.repeat(250);
      const chunks = TextChunker.splitIntoChunks(text, 100);
      expect(chunks.length).toBe(3);
      expect(chunks.join('')).toBe(text);
    });

    it('supports overlap while ensuring complete forward progress to the tail', () => {
      const p1 = 'First sentence here.';
      const p2 = 'Second sentence here.';
      const p3 = 'Third sentence here.';
      const tail = 'Final tail sentence.';
      const text = `${p1}\n\n${p2}\n\n${p3}\n\n${tail}`;

      const chunks = TextChunker.splitIntoChunks(text, 35, 10);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[chunks.length - 1]).toContain(tail);
    });
  });
});
