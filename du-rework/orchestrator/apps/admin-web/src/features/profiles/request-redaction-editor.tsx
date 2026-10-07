import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { RequestRedactionRule } from '@/lib/api';

export function RequestRedactionEditor({ rules, onChange, disabled }: {
  rules: RequestRedactionRule[];
  onChange: (rules: RequestRedactionRule[]) => void;
  disabled: boolean;
}) {
  const update = (index: number, patch: Partial<RequestRedactionRule>) =>
    onChange(rules.map((rule, position) => position === index ? { ...rule, ...patch } : rule));
  return (
    <fieldset className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--border-dark)] p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-semibold">Request input redaction</legend>
      <p className="text-xs text-[var(--text-sub)]">
        Matches are masked before admins and operators receive request input. Processing uses the original input.
        No rules means input is visible. Logs always contain metadata only.
      </p>
      {rules.map((rule, index) => (
        <div key={index} className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Input aria-label={`Redaction pattern ${index + 1}`} className="min-w-0 flex-1" value={rule.pattern}
              placeholder="Regex pattern, without / delimiters" maxLength={512}
              onChange={event => update(index, { pattern: event.target.value })} />
            <Input aria-label={`Redaction replacement ${index + 1}`} className="w-full sm:w-48" value={rule.replacement ?? '[REDACTED]'}
              placeholder="[REDACTED]" maxLength={128}
              onChange={event => update(index, { replacement: event.target.value })} />
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(rules.filter((_, position) => position !== index))}>
              Remove rule {index + 1}
            </Button>
          </div>
          <div className="flex flex-wrap gap-3 text-xs">
            {([['i', 'Ignore case'], ['m', 'Multiline anchors'], ['s', 'Match newlines'], ['u', 'Unicode']] as const).map(([flag, label]) => (
              <label key={flag} className="flex items-center gap-1">
                <input type="checkbox" checked={(rule.flags ?? '').includes(flag)} onChange={event => {
                  const flags = new Set(rule.flags ?? '');
                  if (event.target.checked) flags.add(flag); else flags.delete(flag);
                  update(index, { flags: [...flags].sort().join('') });
                }} />{label}
              </label>
            ))}
          </div>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" disabled={disabled || rules.length >= 20}
        onClick={() => onChange([...rules, { pattern: '', replacement: '[REDACTED]' }])}>Add redaction rule</Button>
      <p className="text-xs text-[var(--text-sub)]">All matches are replaced. Use $1, $2 in the replacement to keep selected capture groups.</p>
    </fieldset>
  );
}
