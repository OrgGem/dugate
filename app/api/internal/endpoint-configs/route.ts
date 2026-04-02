// app/api/internal/endpoint-configs/route.ts
// CRUD for EndpointConnectionConfig — Global admin override for connector chains

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAllEndpointSlugs, SERVICE_REGISTRY } from '@/lib/endpoints/registry';

// GET — List all endpoint configs with registry defaults
export async function GET() {
  try {
    const [configs, allConnections] = await Promise.all([
      prisma.endpointConnectionConfig.findMany({ orderBy: { endpointSlug: 'asc' } }),
      prisma.externalApiConnection.findMany({
        select: { slug: true, name: true, state: true },
        orderBy: { slug: 'asc' },
      }),
    ]);

    // Build full endpoint list from registry with config overlay
    const endpoints = getAllEndpointSlugs().map((ep) => {
      const config = configs.find((c) => c.endpointSlug === ep.slug);
      return {
        slug: ep.slug,
        displayName: ep.displayName,
        serviceName: ep.serviceName,
        serviceSlug: ep.serviceSlug,
        registryConnections: ep.connections,
        // Global admin override
        configId: config?.id ?? null,
        configConnections: config?.connections ? JSON.parse(config.connections) : null,
        configDescription: config?.description ?? null,
        configEnabled: config?.enabled ?? true,
      };
    });

    return NextResponse.json({
      endpoints,
      availableConnections: allConnections,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[GET /endpoint-configs]', msg);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// POST — Upsert endpoint connection config
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { endpointSlug, connections, description, enabled } = body;

    if (!endpointSlug) {
      return NextResponse.json({ error: 'Missing endpointSlug' }, { status: 400 });
    }

    // Validate endpointSlug
    const allSlugs = getAllEndpointSlugs().map((e) => e.slug);
    const serviceSlugs = Object.keys(SERVICE_REGISTRY);
    if (!allSlugs.includes(endpointSlug) && !serviceSlugs.includes(endpointSlug)) {
      return NextResponse.json({ error: `Invalid endpoint slug: '${endpointSlug}'` }, { status: 400 });
    }

    // Validate connections array
    if (!Array.isArray(connections) || connections.length === 0) {
      return NextResponse.json({ error: 'connections must be a non-empty array of connector slugs' }, { status: 400 });
    }

    // Validate each connector exists
    for (const slug of connections) {
      const conn = await prisma.externalApiConnection.findUnique({ where: { slug } });
      if (!conn) {
        return NextResponse.json({ error: `Connector '${slug}' not found` }, { status: 404 });
      }
    }

    const record = await prisma.endpointConnectionConfig.upsert({
      where: { endpointSlug },
      update: {
        connections: JSON.stringify(connections),
        description: description ?? null,
        enabled: typeof enabled === 'boolean' ? enabled : true,
      },
      create: {
        endpointSlug,
        connections: JSON.stringify(connections),
        description: description ?? null,
        enabled: typeof enabled === 'boolean' ? enabled : true,
      },
    });

    return NextResponse.json({ config: record });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[POST /endpoint-configs]', msg);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// DELETE — Remove a config (revert to registry default)
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const endpointSlug = searchParams.get('endpointSlug');

    if (!endpointSlug) {
      return NextResponse.json({ error: 'Missing endpointSlug' }, { status: 400 });
    }

    const existing = await prisma.endpointConnectionConfig.findUnique({
      where: { endpointSlug },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Config not found' }, { status: 404 });
    }

    await prisma.endpointConnectionConfig.delete({
      where: { endpointSlug },
    });

    return NextResponse.json({ deleted: true, endpointSlug });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[DELETE /endpoint-configs]', msg);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
