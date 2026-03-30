// middleware.ts
// Redirect to /setup when no users exist (first-run detection).
// By default the app requires no login — anyone with the URL can use it.
// To enable login: set require_login = true in AppSetting (future feature).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Paths that bypass all middleware checks
const BYPASS_PREFIXES = [
  '/setup',
  '/api/setup',
  '/api/auth',
  '/api/health',
  '/login',
  '/_next',
  '/favicon.ico',
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (BYPASS_PREFIXES.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // --- Public API Integration Protection ---
  if (pathname.startsWith('/api/v1/')) {
    const passedKey = request.headers.get('x-api-key') || '';
    
    // Gọi Internal Endpoint để kiểm tra vì Middleware Edge Runtime không truy cập được Prisma
    try {
      const authUrl = new URL('/api/internal/auth-key', request.url);
      const res = await fetch(authUrl, {
        method: 'GET',
        headers: { 'x-api-key': passedKey },
        cache: 'no-store',
      });
      const data = await res.json();
      
      if (!res.ok || !data.valid) {
        return NextResponse.json(
          { error: data.error || 'Unauthorized' },
          { status: res.status }
        );
      }
    } catch (err) {
      return NextResponse.json({ error: 'Internal Auth Service Error' }, { status: 500 });
    }
    
    // API authenticated, skip the setup check since APIs don't care about UI setup state
    return NextResponse.next();
  }

  // Check if setup is complete (has at least one user)
  try {
    const statusUrl = new URL('/api/setup', request.url);
    const res = await fetch(statusUrl, { cache: 'no-store' });
    const data = await res.json() as { hasUsers: boolean };

    if (!data.hasUsers) {
      return NextResponse.redirect(new URL('/setup', request.url));
    }
  } catch {
    // If status check fails, don't block access
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico).*)',
  ],
};
