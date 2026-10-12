/** Render the stored document result into the legacy requested textual format. */
export function renderLegacyDocumentContent(data: unknown, format: string): string {
  const json = JSON.stringify(data);
  if (format === 'json') return json;
  const object = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const candidate = object.transformedText ?? object.markdown ?? object.text ?? object.summaryText ?? object.content;
  const text = typeof candidate === 'string' ? candidate : json;
  if (format === 'html') {
    if (object.outputFormat === 'html' && typeof object.transformedText === 'string') return object.transformedText;
    return `<pre>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</pre>`;
  }
  if (format === 'csv') {
    const values: unknown[] = Array.isArray(data) ? data : Array.isArray(object.rows) ? object.rows : [data];
    const rows: Record<string, unknown>[] = values.map(value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value });
    const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const cell = (value: unknown) => `"${(typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)).replace(/"/g, '""')}"`;
    return [keys.map(cell).join(','), ...rows.map(row => keys.map(key => cell(row[key])).join(','))].join('\r\n');
  }
  return text;
}
