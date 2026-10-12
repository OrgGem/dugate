import { randomBytes, randomUUID } from 'node:crypto';
import { mintLocalTenantCredential, resolveAdminPrincipal } from '../src/modules/admin-actions/rbac';
import { credentialFor } from '../src/app/admin/bff/upstream';

test('two API replicas accept a tenant-scoped credential with shared service key and different internal admin tokens', () => {
  const key = randomBytes(32).toString('hex'), tenant = randomUUID();
  const token = credentialFor({kind:'tenant_operator',tenantId:tenant},{adminToken:'replica-a',tenantCredentialFor:id=>mintLocalTenantCredential(key,id)});
  expect(token).not.toBe('replica-a');
  expect(resolveAdminPrincipal({adminToken:'replica-b',adminLocalAuthEnabled:true,adminLocalServiceSecret:key},`Bearer ${token}`)).toEqual({role:'tenant_operator',tenantId:tenant});
  expect(resolveAdminPrincipal({adminToken:'replica-b',adminLocalAuthEnabled:true,adminLocalServiceSecret:randomBytes(32).toString('hex')},`Bearer ${token}`)).toBeNull();
  expect(resolveAdminPrincipal({adminLocalServiceSecret:key},`Bearer ${token}`)).toBeNull();
  expect(resolveAdminPrincipal({adminLocalAuthEnabled:true,adminLocalServiceSecret:key},`Bearer ${token!.replace(tenant,randomUUID())}`)).toBeNull();
  expect(resolveAdminPrincipal({adminLocalAuthEnabled:true,adminLocalServiceSecret:key},`Bearer ${token}.suffix`)).toBeNull();
});
test('legacy static credentials retain scope and malformed mint scopes fail closed', () => {
  const tenant=randomUUID(), secret=randomBytes(32).toString('hex');
  expect(resolveAdminPrincipal({adminToken:'platform',tenantAdminTokens:{'static-tenant':tenant}},'Bearer static-tenant')).toEqual({role:'tenant_operator',tenantId:tenant});
  expect(resolveAdminPrincipal({adminToken:'platform'},'Bearer platform')).toEqual({role:'platform'});
  expect(()=>mintLocalTenantCredential(secret,'platform')).toThrow();
  expect(()=>mintLocalTenantCredential('short',tenant)).toThrow();
});
