/**
 * Role-based access control helpers.
 */

export function canMutate(role: string): boolean {
  return role === 'ADMIN' || role === 'USER';
}

export function isAdmin(role: string): boolean {
  return role === 'ADMIN';
}
