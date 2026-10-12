import { useMemo, useState, type ReactNode } from 'react';
import { reviewModel, reviewValueAt, setReviewValue, validateReview, type ReviewField } from './review-schema';

export function ReviewInput({ schema, value, onChange, disabled }: { schema: unknown; value: string; onChange: (value: string) => void; disabled: boolean }) {
  const model = useMemo(() => reviewModel(schema), [schema]);
  const [advanced, setAdvanced] = useState(false);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = null; }
  const objectValue = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  const errors = validateReview(model, value);
  const change = (field: ReviewField, next: unknown) => onChange(JSON.stringify(setReviewValue(parsed, field.path, next), null, 2));
  const render = (field: ReviewField): ReactNode => {
    const current = reviewValueAt(parsed, field.path);
    const id = `review-${encodeURIComponent(JSON.stringify(field.path))}`;
    if (field.type === 'object') return <fieldset key={id} className='border rounded p-3 space-y-3'><legend className='text-sm font-medium'>{field.title}{field.required ? ' *' : ' (optional)'}</legend>
      {field.description && <p className='text-xs'>{field.description}</p>}
      {current === undefined ? <button type='button' className='underline text-sm' disabled={disabled} onClick={() => change(field, {})}>Add {field.title}</button> : <>{field.children?.map(render)}{!field.required && <button type='button' className='underline text-xs' disabled={disabled} onClick={() => change(field, undefined)}>Remove {field.title}</button>}</>}
    </fieldset>;
    const options = field.options ?? (field.type === 'boolean' ? [true, false] : null);
    return <div key={id} className='space-y-1'><label htmlFor={id} className='block text-sm font-medium'>{field.title}{field.required ? ' *' : ' (optional)'}</label>
      {options ? <select id={id} className='block border rounded p-2 w-full' value={current === undefined ? '' : String(options.findIndex(option => option === current))} disabled={disabled} onChange={e => change(field, e.target.value === '' ? undefined : options[Number(e.target.value)])}><option value=''>Choose a value</option>{options.map((option, index) => <option key={index} value={index}>{typeof option === 'boolean' ? option ? 'Yes' : 'No' : String(option)}</option>)}</select>
        : <input id={id} className='block border rounded p-2 w-full' type={field.type === 'string' ? 'text' : 'number'} step={field.type === 'integer' ? 1 : 'any'} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} disabled={disabled} value={current === undefined ? '' : String(current)} onChange={e => change(field, field.type === 'string' ? e.target.value : e.target.value === '' ? undefined : Number(e.target.value))} />}
      {field.description && <p className='text-xs text-[var(--text-sub)]'>{field.description}</p>}
      {!field.required && current !== undefined && <button type='button' className='text-xs underline' disabled={disabled} onClick={() => change(field, undefined)}>Omit {field.title}</button>}
    </div>;
  };
  return <div className='space-y-3'>
    {model.supported && <label className='flex items-center gap-2 text-sm'><input type='checkbox' checked={advanced} onChange={e => { if (e.target.checked || objectValue) setAdvanced(e.target.checked); }} disabled={disabled} />Advanced JSON editor</label>}
    {model.supported && advanced && !objectValue && <p className='text-sm'>Enter a valid JSON object before returning to the guided form. Your current text is preserved.</p>}
    {!model.supported && <p className='text-sm' role='status'>{model.reason} The server validates this response against the full schema.</p>}
    {model.supported && !advanced ? <div className='space-y-3'>{model.fields.map(render)}{model.additionalProperties && <p className='text-xs'>Use the advanced editor for additional fields.</p>}</div> : <label className='block text-sm'>Review response (JSON)<textarea className='block border rounded p-2 w-full min-h-32 font-mono text-xs' value={value} onChange={e => onChange(e.target.value)} disabled={disabled} /></label>}
    {errors.length > 0 && <ul aria-live='polite' className='text-sm text-red-600 list-disc pl-5'>{errors.map(error => <li key={error}>{error}</li>)}</ul>}
    <details><summary className='cursor-pointer text-xs'>Response schema</summary><pre className='text-xs whitespace-pre-wrap break-all'>{JSON.stringify(schema, null, 2)}</pre></details>
  </div>;
}
