import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { AlertBanner, EmptyState } from '@/components/ui/state-panel';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { parseCurlImport, type CurlImportDraft, type CurlImportSummary } from './curl-import';

const TEXTAREA_CLASS =
  'min-h-40 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] p-3 font-mono text-xs';

const CURL_PLACEHOLDER = [
  'curl -X POST https://api.vendor.example/v1/extract \\',
  '  -H authorization:Bearer <token> \\',
  '  -H content-type:application/json \\',
  '  -F prompt=hello',
].join('\n');

export interface CurlImportPreviewProps {
  /** Seed text. The component owns the draft while the operator types. */
  value?: string;
  onChange?: (next: string) => void;
  /** Receives the in-memory draft (secret included) once the operator applies it. */
  onApply?: (draft: CurlImportDraft) => void;
  applyLabel?: string;
  className?: string;
}

/**
 * Import cURL (CFGADM-07) — paste box + preview of what would be imported.
 *
 * Takes raw text and nothing else, and renders exclusively from the redacted
 * summary, so the secret never reaches the rendered output. Nothing is written to
 * local or session storage and nothing is logged: the paste lives in component
 * state until the operator applies it.
 */
export function CurlImportPreview({
  value = '',
  onChange,
  onApply,
  applyLabel = 'Apply to connection',
  className,
}: CurlImportPreviewProps) {
  const [text, setText] = useState(value);

  useEffect(() => {
    setText(value);
  }, [value]);

  const parsed = useMemo(() => parseCurlImport(text), [text]);
  const summary = parsed.ok ? parsed.summary : null;
  const error = parsed.ok ? null : parsed.error;

  const update = (next: string): void => {
    setText(next);
    onChange?.(next);
  };

  const apply = (): void => {
    if (parsed.ok) onApply?.(parsed.draft);
  };

  return (
    <section aria-labelledby='curl-import-title' className={cn('flex flex-col gap-5 min-w-0', className)}>
      <div className='flex flex-wrap items-center gap-3'>
        <h2 id='curl-import-title' className='text-lg font-semibold'>Import cURL</h2>
        <Badge variant='neutral'>text only</Badge>
      </div>

      <AlertBanner variant='info' title='Pasted, never executed'>
        The command is read as text in the browser: nothing is run and no request is sent. Secret values are
        shown masked, and nothing is stored — the paste stays in this component until you apply it.
      </AlertBanner>

      <Card>
        <CardHeader>
          <CardTitle>cURL command</CardTitle>
          <CardDescription>
            Paste a cURL command to prefill method, URL, headers, authentication and form fields.
          </CardDescription>
        </CardHeader>
        <CardContent className='flex flex-col gap-4'>
          <FormField
            id='curl-import-text'
            label='cURL command'
            description='Supports -X/--request, -H/--header, -F/--form, --url and the -d/--data flags. Command substitution, quoting mistakes and oversized pastes are reported, never guessed.'
            error={error === null ? undefined : error.message}
          >
            <textarea
              id='curl-import-text'
              aria-label='cURL command'
              className={TEXTAREA_CLASS}
              value={text}
              onChange={(event) => update(event.target.value)}
              placeholder={CURL_PLACEHOLDER}
              spellCheck={false}
              autoComplete='off'
            />
          </FormField>

          {error === null ? null : (
            <AlertBanner variant='error' title={'Cannot import this command (' + error.code + ')'}>
              {error.message}
              {error.tokenIndex === null ? null : ' (token #' + error.tokenIndex + ')'}
            </AlertBanner>
          )}

          {text.trim().length === 0 ? (
            <EmptyState
              title='Nothing to preview yet'
              description='Paste a cURL command above to see exactly what would be imported.'
            />
          ) : null}

          {summary === null ? null : (
            <CurlImportSummaryView summary={summary} draft={parsed.ok ? parsed.draft : undefined} />
          )}

          <div className='flex flex-wrap items-center justify-between gap-3'>
            <span className='text-xs text-[var(--text-sub)] basis-full sm:basis-auto'>
              Secrets stay masked in the preview — they reach the connection form only when you apply.
            </span>
            <Button onClick={apply} disabled={summary === null || onApply === undefined}>
              {applyLabel}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

interface PreviewRow {
  name: string;
  preview: string;
  badge: ReactNode;
  action?: ReactNode;
}

function PreviewTable({ label, rows }: { label: string; rows: PreviewRow[] }) {
  const hasAction = rows.some((row) => row.action != null);
  return (
    <TableContainer>
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Value</TableHead>
            {hasAction ? <TableHead>Reveal</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={row.name + ':' + index}>
              <TableCell className='font-mono text-xs'>{row.name}</TableCell>
              <TableCell className='text-xs text-[var(--text-sub)]'>
                {row.preview}
                {row.badge}
              </TableCell>
              {hasAction ? <TableCell>{row.action}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function CurlImportSummaryView({
  summary,
  draft,
}: {
  summary: CurlImportSummary;
  /** Raw draft, present when the caller can offer per-field reveal. Header values are never revealed. */
  draft?: CurlImportDraft;
}) {
  const [revealedFields, setRevealedFields] = useState<ReadonlySet<number>>(() => new Set());

  const toggleField = (index: number): void => {
    setRevealedFields((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className='flex flex-col gap-4'>
      <dl className='grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm min-w-0'>
        <dt className='text-[var(--text-sub)]'>Method</dt>
        <dd>
          <Badge variant='info'>{summary.httpMethod}</Badge>
        </dd>
        <dt className='text-[var(--text-sub)]'>URL</dt>
        <dd className='min-w-0 break-words'>
          <code>{summary.endpointUrl}</code>
        </dd>
        <dt className='text-[var(--text-sub)]'>Authentication</dt>
        <dd className='flex flex-wrap items-center gap-2'>
          <Badge variant={summary.auth.type === 'NONE' ? 'neutral' : 'success'}>{summary.auth.type}</Badge>
          {summary.auth.secretPresent ? (
            <span className='text-xs text-[var(--text-sub)]'>
              <code>{summary.auth.headerName}</code>: {summary.auth.preview}
            </span>
          ) : null}
        </dd>
      </dl>

      <div className='flex flex-col gap-2'>
        <h2 className='text-xs font-semibold uppercase tracking-wide text-[var(--text-sub)]'>
          Headers ({summary.headers.length})
        </h2>
        {summary.headers.length === 0 ? (
          <p className='text-xs text-[var(--text-sub)]'>No headers to import.</p>
        ) : (
          <PreviewTable
            label='Imported headers'
            rows={summary.headers.map((header) => ({
              name: header.name,
              preview: header.preview,
              badge: header.secret ? <Badge variant='warning' className='ml-2'>secret</Badge> : null,
            }))}
          />
        )}
      </div>

      <div className='flex flex-col gap-2'>
        <h2 className='text-xs font-semibold uppercase tracking-wide text-[var(--text-sub)]'>
          Form fields ({summary.formFields.length})
        </h2>
        {summary.formFields.length === 0 ? (
          <p className='text-xs text-[var(--text-sub)]'>No form fields to import.</p>
        ) : (
          <PreviewTable
            label='Imported form fields'
            rows={summary.formFields.map((field, index) => {
              const revealed = revealedFields.has(index);
              const raw = draft?.formFields[index];
              return {
                name: field.name,
                preview: revealed && raw !== undefined ? raw.value : field.preview,
                badge: field.isFile ? (
                  <Badge variant='neutral' className='ml-2'>file</Badge>
                ) : field.secret ? (
                  <Badge variant='warning' className='ml-2'>secret</Badge>
                ) : null,
                action:
                  draft === undefined ? null : (
                    <Button
                      size='sm'
                      variant='ghost'
                      aria-pressed={revealed}
                      aria-label={(revealed ? 'Hide value for ' : 'Show value for ') + field.name}
                      onClick={() => toggleField(index)}
                    >
                      {revealed ? 'Hide' : 'Show'}
                    </Button>
                  ),
              };
            })}
          />
        )}
      </div>

      {summary.notes.length === 0 ? null : (
        <AlertBanner variant='warning' title='Not imported'>
          <ul className='list-disc pl-4'>
            {summary.notes.map((note) => (
              <li key={note.code}>{note.message}</li>
            ))}
          </ul>
        </AlertBanner>
      )}
    </div>
  );
}
