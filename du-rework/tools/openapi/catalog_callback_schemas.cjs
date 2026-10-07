// SC-04 / CB-05: project current canonical Zod source into OpenAPI 3.0.
// Load TypeScript source in this one-shot process, never stale dist artifacts.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../orchestrator/packages/contracts');
const localRequire = createRequire(path.join(root, 'package.json'));
const ts = localRequire('typescript');
require.extensions['.ts'] = (module, filename) => {
  if (!filename.startsWith(root + path.sep)) throw new Error('Unexpected source: ' + filename);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

function convert(schema) {
  const d = schema._def;
  switch (d.typeName) {
    case 'ZodEffects':
      return { ...convert(d.schema), 'x-runtime-validation': 'Canonical Zod refinements apply in addition to this structural projection.' };
    case 'ZodOptional': return convert(d.innerType);
    case 'ZodNullable': return { ...convert(d.innerType), nullable: true };
    case 'ZodLiteral': return { type: typeof d.value, enum: [d.value] };
    case 'ZodEnum': return { type: 'string', enum: d.values };
    case 'ZodString': {
      const out = { type: 'string' };
      for (const c of d.checks) {
        if (c.kind === 'min') out.minLength = c.value;
        else if (c.kind === 'max') out.maxLength = c.value;
        else if (c.kind === 'regex') out.pattern = c.regex.source;
        else if (['uuid', 'datetime', 'url'].includes(c.kind)) out.format = { uuid: 'uuid', datetime: 'date-time', url: 'uri' }[c.kind];
        else throw new Error('Unsupported string check: ' + c.kind);
      }
      return out;
    }
    case 'ZodNumber': {
      const out = { type: 'number' };
      for (const c of d.checks) {
        if (c.kind === 'int') out.type = 'integer';
        else if (c.kind === 'min' || c.kind === 'max') out[c.kind === 'min' ? 'minimum' : 'maximum'] = c.value;
        else throw new Error('Unsupported number check: ' + c.kind);
      }
      return out;
    }
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodUnknown': return {};
    case 'ZodRecord': return { type: 'object', additionalProperties: convert(d.valueType), 'x-key-schema': convert(d.keyType) };
    case 'ZodArray': {
      const out = { type: 'array', items: convert(d.type) };
      if (d.minLength) out.minItems = d.minLength.value;
      if (d.maxLength) out.maxItems = d.maxLength.value;
      return out;
    }
    case 'ZodObject': {
      const properties = {};
      const required = [];
      for (const [name, child] of Object.entries(d.shape())) {
        properties[name] = convert(child);
        if (!child.isOptional()) required.push(name);
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: d.unknownKeys !== 'strict' };
    }
    case 'ZodUnion': return { anyOf: d.options.map(convert) };
    case 'ZodDiscriminatedUnion': return { oneOf: [...d.options.values()].map(convert), discriminator: { propertyName: d.discriminator } };
    default: throw new Error('Unsupported Zod type: ' + d.typeName);
  }
}

const schemas = {};
for (const file of ['secret-catalog', 'profile-callback']) {
  const exports = require(path.join(root, 'src', file + '.ts'));
  for (const [name, value] of Object.entries(exports)) {
    if (!name.endsWith('Schema')) continue;
    const key = name.slice(0, -6);
    schemas[key] = { ...convert(value), 'x-source': 'orchestrator/packages/contracts/src/' + file + '.ts#' + name };
  }
}
schemas.LiteralValueSource.properties.value.writeOnly = true;
schemas.SecretCatalogCreate.properties.value.writeOnly = true;
schemas.SecretCatalogRotate.properties.value.writeOnly = true;
schemas.ProfileCallbackPolicy.description = 'Contract model; policy.callbackPolicy profile/admission plumbing is not implemented in the current router snapshot. Credential auth requires approved exact HTTPS destinations; no redirects. Endpoint policy > profile default > legacy notification_only. Runtime refinements reject reserved/duplicate headers and private destinations.';
schemas.CallbackResultEnvelope.description = 'Outgoing receiver body, not a new platform endpoint. Inline result <=256 KiB, whole delivery <=512 KiB, <=32 descriptors; null result requires explicit omission reason; never truncate or expose storage URLs. Retry replays the terminal snapshot; deduplicate x-du-delivery-id.';
schemas.CallbackAuth.description = 'Managed-secret opaque refs only; catalog secretId ValueSource and callback managed-secret ref formats are distinct until consumer mapping is implemented. OAuth2 lifetime absent means acquire per delivery; redirects denied.';
const publicApi = require(path.join(root, 'src/public-api.ts'));
schemas.WebhookNotificationEnvelope = { ...convert(publicApi.WebhookPayloadSchema),
  description: 'Legacy notification_only canonical body; dispatcher additionally stamps stable deliveryId. Receiver must also deduplicate x-du-delivery-id.',
  'x-source': 'orchestrator/packages/contracts/src/public-api.ts#WebhookPayloadSchema' };
schemas.WebhookNotificationEnvelope.properties.deliveryId.description = 'Dispatcher-stamped stable delivery row identifier.';
process.stdout.write(JSON.stringify(schemas));
