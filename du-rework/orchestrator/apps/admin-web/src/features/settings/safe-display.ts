export const EFFECTIVE_STORAGE_FIELDS = ['backend', 'bucket', 'region', 'endpoint'] as const;

export function safeStorageValue(key: string, value: unknown): string {
  if (value === null) return 'Not explicitly configured';
  if (typeof value !== 'string') return 'Unavailable';
  if (key !== 'endpoint') return value;
  try {
    const endpoint = new URL(value);
    endpoint.username = '';
    endpoint.password = '';
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint.toString();
  } catch {
    return 'Endpoint unavailable';
  }
}
