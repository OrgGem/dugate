const http = require('node:http');

function createAdminShellSessionGate(proxyTarget) {
  return {
    name: 'du-admin-shell-html-session-gate',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const method = (req.method || 'GET').toUpperCase();
        const acceptsHtml = String(req.headers.accept || '').includes('text/html');
        let pathname;
        try { pathname = new URL(req.url || '/', 'http://vite.local').pathname; } catch { return next(); }
        const isAdminPage = pathname === '/admin' || pathname.startsWith('/admin/');
        const isAuthOrBff = ['/admin/api', '/admin/login', '/admin/logout', '/admin/oidc/callback']
          .some((route) => pathname === route || pathname.startsWith(`${route}/`));
        if (!['GET', 'HEAD'].includes(method) || !acceptsHtml || !isAdminPage || isAuthOrBff) return next();

        let finished = false;
        const failClosed = () => {
          if (finished || res.destroyed) return;
          finished = true;
          res.statusCode = 503;
          res.setHeader('cache-control', 'no-store');
          res.end('Admin Shell authentication service is unavailable.');
        };
        const gateHeaders = Object.fromEntries(Object.entries({
          accept: req.headers.accept,
          cookie: req.headers.cookie,
          host: req.headers.host,
          origin: req.headers.origin,
          'user-agent': req.headers['user-agent'],
          'x-forwarded-for': req.headers['x-forwarded-for'],
          'x-forwarded-proto': req.headers['x-forwarded-proto'],
        }).filter(([, value]) => value !== undefined));
        let gateRequest;
        try {
          gateRequest = http.request(new URL(req.url || '/admin/', proxyTarget), {
            method,
            headers: gateHeaders,
            timeout: 3000,
          }, (gateResponse) => {
            gateResponse.resume();
            gateResponse.once('end', () => {
              if (finished || res.destroyed) return;
              finished = true;
              const status = gateResponse.statusCode || 503;
              if (status === 200 || status === 304) return next();
              res.statusCode = status;
              res.setHeader('cache-control', gateResponse.headers['cache-control'] || 'no-store');
              for (const header of ['location', 'content-type', 'x-correlation-id', 'set-cookie']) {
                if (gateResponse.headers[header] !== undefined) res.setHeader(header, gateResponse.headers[header]);
              }
              res.end();
            });
          });
        } catch { return failClosed(); }
        gateRequest.once('timeout', () => gateRequest.destroy(new Error('Admin Shell gate timed out')));
        gateRequest.once('error', failClosed);
        gateRequest.end();
      });
    },
  };
}

function createAdminWebDevServerOptions({ host, port, internalAdminShellPort }) {
  const proxyTarget = `http://127.0.0.1:${internalAdminShellPort}`;
  const paths = ['/admin/api', '/admin/login', '/admin/logout', '/admin/oidc/callback'];
  const proxy = Object.fromEntries(paths.map((route) => [route, { target: proxyTarget, changeOrigin: false }]));
  return {
    plugins: [createAdminShellSessionGate(proxyTarget)],
    server: { host, port, strictPort: true, proxy },
  };
}

module.exports = { createAdminShellSessionGate, createAdminWebDevServerOptions };
