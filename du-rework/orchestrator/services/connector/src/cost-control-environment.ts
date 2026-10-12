/** Resolve the mandatory production Connector cost-control endpoint. */
export function costControlFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: { isolatedRestoreRehearsal?: boolean } = {},
): { baseUrl: string; token: string } | undefined {
  const url = env.COST_CONTROL_CONNECTOR_URL;
  const token = env.COST_CONTROL_CONNECTOR_TOKEN;
  const hasUrl = typeof url === 'string' && url.length > 0;
  const hasToken = typeof token === 'string' && token.length > 0;
  if (!hasUrl && !hasToken) {
    if (env.NODE_ENV === 'production' && !options.isolatedRestoreRehearsal) {
      throw new Error('Production Connector requires COST_CONTROL_CONNECTOR_URL and COST_CONTROL_CONNECTOR_TOKEN.');
    }
    return undefined;
  }
  if (!hasUrl || !hasToken || token!.length < 32 || token!.length > 512) {
    throw new Error('Cost-control Connector URL and token must be configured together with a 32–512 character token.');
  }
  if (token === env.INVOCATION_GRANT_SECRET || token === env.SERVICE_IDENTITY_SECRET || token === env.USAGE_SINK_TOKEN) {
    throw new Error('Cost-control Connector token must be distinct from Connector grant, service identity, and usage sink credentials.');
  }
  const parsed = new URL(url!);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Cost-control Connector URL must be an HTTP(S) base URL without userinfo, query, or fragment.');
  }
  return { baseUrl: parsed.toString().replace(/\/+$/, ''), token: token! };
}
