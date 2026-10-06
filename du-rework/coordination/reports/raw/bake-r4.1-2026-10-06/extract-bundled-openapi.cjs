const fs = require('fs');
const vm = require('vm');
for (const name of fs.readdirSync('/app/admin-web/assets')) {
  if (!name.endsWith('.js')) continue;
  const text = fs.readFileSync('/app/admin-web/assets/' + name, 'utf8');
  const regex = /`(?:\\[\s\S]|[^`\\])*`/g;
  for (const match of text.matchAll(regex)) {
    if (!match[0].includes('"openapi"')) continue;
    const value = vm.runInNewContext(match[0], Object.create(null), {timeout: 1000});
    const doc = JSON.parse(value);
    if (doc.openapi === '3.0.3' && doc.info.version === '1.4.0') {
      fs.writeFileSync(1, value);
      process.exit(0);
    }
  }
}
throw new Error('Bundled OpenAPI literal not found');

