import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createAdminApiClient, type TenantRow } from '@/lib/api';

const STORAGE_KEY = 'du_global_tenant_id';

export interface TenantContextValue {
  tenantId: string | null;
  tenant: TenantRow | null;
  tenants: TenantRow[];
  loading: boolean;
  tenantLoadError: string | null;
  setTenantId: (id: string | null) => void;
  refreshTenants: () => Promise<void>;
}

const TenantContext = createContext<TenantContextValue | null>(null);

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const client = useMemo(() => createAdminApiClient(), []);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [tenantId, setTenantIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);
  const [tenantLoadError, setTenantLoadError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);

  const refreshTenants = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setLoading(true);
    setTenantLoadError(null);
    try {
      const rows: TenantRow[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      while (true) {
        const res = await client.listTenants({ limit: '100', ...(cursor !== null ? { cursor } : {}) });
        if (generation !== refreshGeneration.current) return;
        if (!res.ok) {
          throw new Error(res.problem.title ?? 'Tenant roster could not be loaded.');
        }
        rows.push(...(res.data.items ?? []));
        const next = res.data.nextCursor;
        if (next === null) break;
        if (cursors.has(next) || next === cursor) {
          throw new Error('Tenant roster pagination returned a repeated cursor.');
        }
        cursors.add(next);
        cursor = next;
      }
      const uniqueRows = [...new Map(rows.map((row) => [row.id, row])).values()];
      if (generation !== refreshGeneration.current) return;
      setTenants(uniqueRows);
      setTenantIdState((currentId) => {
        if (currentId && uniqueRows.some((tenantRow) => tenantRow.id === currentId)) return currentId;
        const defaultTenant = uniqueRows.find((tenantRow) => tenantRow.name.toLowerCase().includes('default') && tenantRow.state === 'ACTIVE')
          ?? uniqueRows.find((tenantRow) => tenantRow.state === 'ACTIVE')
          ?? uniqueRows[0];
        const newId = defaultTenant?.id ?? null;
        try {
          if (newId) localStorage.setItem(STORAGE_KEY, newId);
          else localStorage.removeItem(STORAGE_KEY);
        } catch {}
        return newId;
      });
    } catch (error) {
      if (generation === refreshGeneration.current) {
        setTenantLoadError(error instanceof Error ? error.message : 'Tenant roster could not be loaded.');
      }
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refreshTenants();
    return () => { refreshGeneration.current += 1; };
  }, [refreshTenants]);

  const setTenantId = (id: string | null) => {
    setTenantIdState(id);
    try {
      if (id) {
        localStorage.setItem(STORAGE_KEY, id);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {}
  };

  const tenant = useMemo(() => {
    return tenants.find((t) => t.id === tenantId) ?? null;
  }, [tenants, tenantId]);

  return (
    <TenantContext.Provider
      value={{
        tenantId,
        tenant,
        tenants,
        loading,
        tenantLoadError,
        setTenantId,
        refreshTenants,
      }}
    >
      {children}
    </TenantContext.Provider>
  );
}

export function useTenant(): TenantContextValue {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error('useTenant must be used within a TenantProvider');
  }
  return context;
}
