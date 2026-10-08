// F-3 auxiliary checks: (1) does the offline codec suite's boundary regex still match the
// scope-amended subquery? (2) does the app's cursor decode accept the tokens used?
const BOUNDARY_RE =
  /\(lower\(name\), id\) ([<>]) \(\(SELECT lower\(name\) FROM tenants WHERE id = \$(\d+)\), \$(\d+)::uuid\)/;

const scopedSql =
  'SELECT id, name, state FROM tenants WHERE id = $1 AND (lower(name), id) > ((SELECT lower(name) FROM tenants WHERE id = $2 AND id = $1), $2::uuid) ORDER BY lower(name) ASC, id ASC LIMIT $3';
const platformSql =
  'SELECT id, name, state FROM tenants WHERE (lower(name), id) > ((SELECT lower(name) FROM tenants WHERE id = $1), $1::uuid) ORDER BY lower(name) ASC, id ASC LIMIT $2';

console.log('scoped_boundary_regex_matches=' + BOUNDARY_RE.test(scopedSql));
console.log('platform_boundary_regex_matches=' + BOUNDARY_RE.test(platformSql));
