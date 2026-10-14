import * as React from 'react';
import { Input, type InputProps } from './input';
import { cn } from '@/lib/utils';
import {
  appendReferenceOptions,
  createReferenceRequestGate,
  filterReferenceOptions,
  referenceValueForScope,
  type ReferenceOption,
  type ReferenceOptionPage,
} from './reference-input-state';

export type { ReferenceOption, ReferenceOptionPage } from './reference-input-state';

export interface ReferenceInputProps extends Omit<InputProps, 'value' | 'onChange' | 'onKeyDown' | 'onFocus' | 'onBlur'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Null disables catalog reads. Changing it clears this reference and all suggestions. */
  scopeKey: string | null;
  loadOptions: (query: string, scopeKey: string, cursor: string | null) => Promise<ReferenceOptionPage>;
  searchDelayMs?: number;
  /** Callers with an in-memory catalog can bump this to refresh its suggestions. */
  sourceVersion?: string | number;
}

type SuggestionsState = {
  scopeKey: string | null;
  query: string;
  items: ReferenceOption[];
  nextCursor: string | null;
  status: 'idle' | 'loading' | 'loading-more' | 'ready' | 'failed';
  error?: string;
};

const emptySuggestions = (scopeKey: string | null, query: string): SuggestionsState => ({
  scopeKey,
  query,
  items: [],
  nextCursor: null,
  status: 'idle',
});

export function ReferenceInput({
  value,
  onValueChange,
  scopeKey,
  loadOptions,
  searchDelayMs = 180,
  sourceVersion,
  className,
  ...inputProps
}: ReferenceInputProps) {
  const listId = `reference-options-${React.useId().replaceAll(':', '')}`;
  const previousScope = React.useRef(scopeKey);
  const requestGate = React.useRef(createReferenceRequestGate());
  const rootRef = React.useRef<HTMLDivElement>(null);
  const loadOptionsRef = React.useRef(loadOptions);
  loadOptionsRef.current = loadOptions;
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [suggestions, setSuggestions] = React.useState<SuggestionsState>(() => emptySuggestions(scopeKey, ''));
  const scopeChanged = previousScope.current !== scopeKey;
  const visibleValue = referenceValueForScope(value, previousScope.current, scopeKey);
  const normalizedQuery = visibleValue.trim();
  const currentSuggestions = suggestions.scopeKey === scopeKey && suggestions.query === normalizedQuery
    ? suggestions
    : emptySuggestions(scopeKey, normalizedQuery);
  const visibleOptions = filterReferenceOptions(currentSuggestions.items, normalizedQuery);
  const readOnly = inputProps.readOnly === true;
  const disabled = inputProps.disabled === true;

  React.useLayoutEffect(() => {
    if (previousScope.current === scopeKey) return;
    previousScope.current = scopeKey;
    requestGate.current.invalidate();
    setSuggestions(emptySuggestions(scopeKey, ''));
    setActiveIndex(-1);
    setOpen(false);
    onValueChange('');
  }, [onValueChange, scopeKey]);

  React.useEffect(() => {
    const liveScope = scopeKey;
    const query = normalizedQuery;
    if (scopeChanged || disabled || readOnly || !open || liveScope === null) {
      requestGate.current.invalidate();
      if (liveScope === null) setSuggestions(emptySuggestions(null, query));
      if (disabled || readOnly) setOpen(false);
      return;
    }

    const ticket = requestGate.current.begin(liveScope, query);
    setSuggestions({ scopeKey: liveScope, query, items: [], nextCursor: null, status: 'loading' });
    const timer = window.setTimeout(() => {
      void loadOptionsRef.current(query, liveScope, null).then((page) => {
        if (!requestGate.current.isCurrent(ticket, liveScope, query)) return;
        setSuggestions({
          scopeKey: liveScope,
          query,
          items: page.items,
          nextCursor: page.nextCursor,
          status: 'ready',
        });
      }).catch((error: unknown) => {
        if (!requestGate.current.isCurrent(ticket, liveScope, query)) return;
        setSuggestions({
          scopeKey: liveScope,
          query,
          items: [],
          nextCursor: null,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Suggestions could not be loaded.',
        });
      });
    }, searchDelayMs);

    return () => {
      window.clearTimeout(timer);
      requestGate.current.invalidate();
    };
  }, [disabled, normalizedQuery, open, readOnly, scopeChanged, scopeKey, searchDelayMs, sourceVersion]);

  async function loadMore(): Promise<void> {
    const cursor = currentSuggestions.nextCursor;
    const liveScope = scopeKey;
    const query = normalizedQuery;
    if (disabled || readOnly || !cursor || !liveScope || currentSuggestions.status === 'loading-more') return;
    const ticket = requestGate.current.begin(liveScope, query);
    setSuggestions({ ...currentSuggestions, status: 'loading-more', error: undefined });
    try {
      const page = await loadOptionsRef.current(query, liveScope, cursor);
      if (!requestGate.current.isCurrent(ticket, liveScope, query)) return;
      setSuggestions((current) => current.scopeKey === liveScope && current.query === query
        ? {
            ...current,
            items: appendReferenceOptions(current.items, page.items),
            nextCursor: page.nextCursor,
            status: 'ready',
          }
        : current);
    } catch (error) {
      if (!requestGate.current.isCurrent(ticket, liveScope, query)) return;
      setSuggestions((current) => current.scopeKey === liveScope && current.query === query
        ? {
            ...current,
            status: 'failed',
            error: error instanceof Error ? error.message : 'More suggestions could not be loaded.',
          }
        : current);
    }
  }

  function selectOption(option: ReferenceOption): void {
    if (disabled || readOnly) return;
    onValueChange(option.value);
    requestGate.current.invalidate();
    setSuggestions(emptySuggestions(scopeKey, option.value.trim()));
    setActiveIndex(-1);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' && !open) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(visibleOptions.length > 0 ? 0 : -1);
    } else if (event.key === 'ArrowDown' && visibleOptions.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => Math.min(visibleOptions.length - 1, current + 1));
    } else if (event.key === 'ArrowUp' && !open) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(visibleOptions.length > 0 ? visibleOptions.length - 1 : -1);
    } else if (event.key === 'ArrowUp' && visibleOptions.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => Math.max(0, current <= 0 ? visibleOptions.length - 1 : current - 1));
    } else if (event.key === 'Enter' && open && activeIndex >= 0 && visibleOptions[activeIndex]) {
      event.preventDefault();
      selectOption(visibleOptions[activeIndex]!);
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    } else if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete') {
      setActiveIndex(-1);
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative min-w-0 w-full"
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) return;
        setOpen(false);
        setActiveIndex(-1);
      }}
    >
      <Input
        {...inputProps}
        className={cn(className)}
        value={visibleValue}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 && visibleOptions[activeIndex]
          ? `${listId}-option-${activeIndex}`
          : undefined}
        autoComplete={inputProps.autoComplete ?? 'off'}
        onChange={(event) => {
          onValueChange(event.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) return;
          setOpen(false);
          setActiveIndex(-1);
        }}
        onKeyDown={handleKeyDown}
      />
      {open && !disabled && !readOnly ? (
        <div className="absolute left-0 top-full z-40 mt-1 w-full overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-[var(--shadow-pop)]">
          <ul id={listId} role="listbox" aria-label="Reference suggestions" className="max-h-56 overflow-auto p-1">
            {visibleOptions.map((option, index) => (
              <li
                id={`${listId}-option-${index}`}
                key={option.value}
                role="option"
                aria-selected={activeIndex === index}
                className={cn(
                  'cursor-pointer rounded-[var(--radius-sm)] px-2 py-1.5 text-sm',
                  activeIndex === index ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(option)}
              >
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="min-w-0 break-all font-medium">{option.label}</span>
                  <code className="min-w-0 break-all text-xs text-[var(--text-sub)]">{option.value}</code>
                  {option.description ? <span className="min-w-0 break-all text-xs text-[var(--text-sub)]">{option.description}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {currentSuggestions.status === 'loading'
            ? <p role="status" className="px-3 py-2 text-xs text-[var(--text-sub)]">Loading suggestions…</p>
            : null}
          {currentSuggestions.status === 'ready' && visibleOptions.length === 0
            ? <p role="status" className="px-3 py-2 text-xs text-[var(--text-sub)]">No matching suggestions. You can still enter an ID.</p>
            : null}
          {currentSuggestions.status === 'failed'
            ? <p role="status" className="px-3 py-2 text-xs text-[var(--badge-danger-text)]">{currentSuggestions.error ?? 'Suggestions unavailable.'} You can still enter an ID.</p>
            : null}
          {currentSuggestions.nextCursor ? (
            <div className="border-t border-[var(--border-subtle)] px-3 py-1.5">
              <button
                type="button"
                className="text-left text-xs text-[var(--text-link)] underline disabled:opacity-50"
                disabled={currentSuggestions.status === 'loading-more'}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void loadMore()}
              >
                {currentSuggestions.status === 'loading-more' ? 'Loading more suggestions…' : 'Load more suggestions'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
