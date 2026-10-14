export interface ReferenceOption {
  value: string;
  label: string;
  description?: string;
}

export interface ReferenceOptionPage {
  items: ReferenceOption[];
  nextCursor: string | null;
}

export interface ReferenceRequestTicket {
  generation: number;
  scopeKey: string;
  query: string;
}

/** Rejects results after either the query or its data scope has moved on. */
export function createReferenceRequestGate() {
  let generation = 0;

  return {
    begin(scopeKey: string, query: string): ReferenceRequestTicket {
      generation += 1;
      return { generation, scopeKey, query };
    },
    invalidate(): void {
      generation += 1;
    },
    isCurrent(ticket: ReferenceRequestTicket, scopeKey: string, query: string): boolean {
      return ticket.generation === generation
        && ticket.scopeKey === scopeKey
        && ticket.query === query;
    },
  };
}

/** A reference from a prior scope is never visible during the scope-change render. */
export function referenceValueForScope(value: string, previousScope: string | null, currentScope: string | null): string {
  return previousScope === currentScope ? value : '';
}

export function filterReferenceOptions(options: readonly ReferenceOption[], query: string): ReferenceOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return [...options];
  return options.filter((option) => `${option.value} ${option.label} ${option.description ?? ''}`
    .toLocaleLowerCase()
    .includes(normalized));
}

export function appendReferenceOptions(current: readonly ReferenceOption[], next: readonly ReferenceOption[]): ReferenceOption[] {
  const byValue = new Map(current.map((option) => [option.value, option]));
  for (const option of next) byValue.set(option.value, option);
  return [...byValue.values()];
}
