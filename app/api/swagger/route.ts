import { createSwaggerSpec } from 'next-swagger-doc';

export async function GET() {
  const spec = createSwaggerSpec({
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'Dugate - Document Understanding API',
        version: '1.0.0',
        description: 'Public APIs for integration with Dugate services (Transform, Compare, Generate). All requests to /api/v1 must include the `x-api-key` header.',
      },
      servers: [
        {
          url: 'http://localhost:2023',
          description: 'Local Development',
        },
      ],
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'x-api-key',
            description: 'Provide your API key in the `x-api-key` header.',
          },
        },
      },
      security: [
        {
          ApiKeyAuth: [],
        },
      ],
    },
    apiFolder: 'app/api/v1',
  });

  return Response.json(spec);
}
