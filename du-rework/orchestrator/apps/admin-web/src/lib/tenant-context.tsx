import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createAdminApiClient, type TenantRow } from '@/lib/api';

const STORAGE_KEY = 'du_global_tenant_id';

export interface TenantContextValue {
  tenantId: string | null;
  tenant: TenantRow | null;
  tenants: TenantRow[];
  loading: boolean;
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

  const refreshTenants = async () => {
    setLoading(true);
    try {
      const res = await client.listTenants({ limit: '100' });
      if (res.ok) {
        const rows = res.data.items ?? [];
        setTenants(rows);
        
        // Auto-select default tenant if none selected or current is invalid
        setTenantIdState((currentId) => {
          const exists = rows.some((t) => t.id === currentId);
          if (currentId && exists) return currentId;
          
          // Prefer active default tenant, or first available tenant
          const defaultTenant = rows.find((t) => t.name.toLowerCase().includes('default') && t.state === 'ACTIVE')
            ?? rows.find((t) => t.state === 'ACTIVE')
            ?? rows[0];

          const newId = defaultTenant?.id ?? null;
          if (newId) {
            try {
              localStorage.setItem(STORAGE_KEY, newId);
            } catch {}
          }
          return newId;
        });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshTenants();
  }, []);

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
