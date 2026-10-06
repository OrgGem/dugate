import { Link } from 'react-router';

export function NotFound() {
  return (
    <section aria-labelledby="not-found-title">
      <h1 id="not-found-title" className="text-lg font-semibold">
        Page not found
      </h1>
      <p className="mt-2 text-sm text-ink-muted">
        No Orchestrator Portal route matches this URL yet. Screens are added route-by-route; the legacy
        shell keeps serving every path that has not been migrated.
      </p>
      <p className="mt-4 text-sm">
        <Link className="text-action underline" to="/">
          Back to bootstrap
        </Link>{' '}
        ·{' '}
        <a className="text-action underline" href="/admin">
          Legacy shell
        </a>
      </p>
    </section>
  );
}
