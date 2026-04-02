import * as xlsx from 'xlsx';
import { DocumentParser, ParseResult } from './interface';

export class ExcelParser implements DocumentParser {
  canHandle(mimeType: string, extension: string): boolean {
    const validTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv'
    ];
    return validTypes.includes(mimeType) || ['.xlsx', '.xls', '.csv'].includes(extension.toLowerCase());
  }

  async parse(fileBuffer: Buffer, fileName: string): Promise<ParseResult> {
    // xlsx.read works completely synchronously but we keep async interface
    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
    let fullMarkdown = '';
    let fullText = '';
    let totalCells = 0;
    
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false }) as any[][];
      
      if (rows.length === 0) continue;
      
      fullMarkdown += `### Sheet: ${sheetName}\n\n`;
      fullText += `--- Sheet: ${sheetName} ---\n`;
      
      // Determine max columns
      let numCols = 0;
      for (const row of rows) {
        if (row.length > numCols) numCols = row.length;
      }
      
      if (numCols > 0) {
        // Build Headers
        const headerRow = rows[0] || [];
        const headerStrings = Array.from({length: numCols}, (_, i) => {
           let val = headerRow[i] !== undefined && headerRow[i] !== null ? String(headerRow[i]) : `Col ${i+1}`;
           return val.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        });

        fullMarkdown += `| ${headerStrings.join(' | ')} |\n`;
        fullMarkdown += `| ${headerStrings.map(() => '---').join(' | ')} |\n`;
        fullText += headerStrings.join('\t') + '\n';
        totalCells += numCols;
        
        // Build Rows
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i] || [];
          const rowStrings = Array.from({length: numCols}, (_, j) => {
            let val = row[j] !== undefined && row[j] !== null ? String(row[j]) : '';
            return val.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
          });
          
          fullMarkdown += `| ${rowStrings.join(' | ')} |\n`;
          fullText += rowStrings.join('\t') + '\n';
          totalCells += numCols;
        }
      }
      
      fullMarkdown += '\n';
      fullText += '\n';
    }

    return {
      text: fullText.trim(),
      markdown: fullMarkdown.trim(),
      metadata: {
        sheetNames: workbook.SheetNames,
        totalCells
      }
    };
  }
}
