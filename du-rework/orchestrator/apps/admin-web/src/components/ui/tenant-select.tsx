import { useEffect, useMemo, useState } from 'react';
import {
  SelectItem,
  SelectPopup,
  SelectPortal,
  SelectPositioner,
  SelectRoot,
  SelectTrigger,
  SelectValue,
} from './select';
import { createAdminApiClient, type TenantRow } from '@/lib/api';

const ALL_TENANTS_VALUE = '__all_tenants__';

export interface TenantSelectProps {
  id: string;
  label?: string | null;
  ariaLabel?: string;
  description?: string;
  value: string | null;
  onValueChange(value: string | null): void;
  /** Render an All tenants option and report it as null. */
  allowAll?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Tenant picker backed by the Admin BFF roster: platform admins see all
 * tenants, and tenant operators see only their own row. IDs are values only;
 * visible options and selected values render names.
 */
export function TenantSelect({
  id,
  label = 'Tenant',
  ariaLabel,
  description,
  value,
  onValueChange,
  allowAll = false,
  disabled = false,
  className,
}: TenantSelectProps): React.JSX.Element {
  const client = useMemo(() => createAdminApiClient(), []);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let active = true;
    async function loadTenants(): Promise<void> {
      const rows: TenantRow[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const result = await client.listTenants({ limit: '100', ...(cursor === null ? {} : { cursor }) });
        if (!result.ok) {
          if (active) {
            setTenants([]);
            setLoadState('failed');
          }
          return;
        }
        rows.push(...result.data.items);
        cursor = result.data.nextCursor;
        if (cursor !== null) {
          if (cursors.has(cursor)) {
            if (active) {
              setTenants([]);
              setLoadState('failed');
            }
            return;
          }
          cursors.add(cursor);
        }
      } while (cursor !== null);

      if (active) {
        setTenants(rows);
        setLoadState('ready');
      }
    }

    void loadTenants();
    return () => {
      active = false;
    };
  }, [client]);

  const selectedValue = value === null
    ? allowAll ? ALL_TENANTS_VALUE : null
    : tenants.some((tenant) => tenant.id === value) ? value : null;
  const unavailable = loadState === 'failed';
  const empty = loadState === 'ready' && tenants.length === 0;
  const placeholder = loadState === 'loading'
    ? 'Loading tenants…'
    : unavailable
      ? 'Tenant list unavailable'
      : empty
        ? 'No tenants available'
        : 'Select a tenant';
  const descriptionId = `${id}-description`;
  const statusId = `${id}-status`;
  const describedBy = [
    description ? descriptionId : null,
    loadState !== 'ready' || empty ? statusId : null,
  ].filter((part): part is string => part !== null).join(' ') || undefined;

  return (
    <div className={`flex w-full min-w-0 flex-col gap-1.5${className ? ` ${className}` : ''}`}>
      {label !== null ? (
        <label htmlFor={id} className="text-xs font-semibold text-[var(--text-main)] select-none">
          {label}
        </label>
      ) : null}
      <SelectRoot
        value={selectedValue}
        onValueChange={(nextValue) => {
          if (nextValue === ALL_TENANTS_VALUE && allowAll) {
            onValueChange(null);
          } else if (typeof nextValue === 'string' && tenants.some((tenant) => tenant.id === nextValue)) {
            onValueChange(nextValue);
          }
        }}
        disabled={disabled || loadState !== 'ready' || tenants.length === 0}
      >
        <SelectTrigger
          id={id}
          aria-label={ariaLabel ?? label ?? 'Tenant'}
          aria-describedby={describedBy}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectPortal>
          <SelectPositioner>
            <SelectPopup>
              {allowAll ? <SelectItem value={ALL_TENANTS_VALUE}>All tenants</SelectItem> : null}
              {tenants.map((tenant) => (
                <SelectItem key={tenant.id} value={tenant.id}>
                  {tenant.state === 'ACTIVE' ? tenant.name : `${tenant.name} (${tenant.state})`}
                </SelectItem>
              ))}
            </SelectPopup>
          </SelectPositioner>
        </SelectPortal>
      </SelectRoot>
      {description ? <p id={descriptionId} className="text-xs text-[var(--text-sub)]">{description}</p> : null}
      {loadState === 'loading' ? <p id={statusId} className="text-xs text-[var(--text-sub)]">Loading tenant names…</p> : null}
      {unavailable ? <p id={statusId} role="alert" className="text-xs text-[var(--badge-danger-text)]">Tenant names are unavailable for this session.</p> : null}
      {empty ? <p id={statusId} className="text-xs text-[var(--text-sub)]">No tenants are available.</p> : null}
    </div>
  );
}
