import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAllEndpointSlugs } from "@/lib/endpoints/registry";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const BEARER_PREFIX = "Bearer ";

  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!internalSecret) {
    return NextResponse.json({ error: "INTERNAL_API_SECRET is not configured" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const bearer = req.headers.get("authorization");
  const bearerToken = bearer?.startsWith(BEARER_PREFIX) ? bearer.slice(BEARER_PREFIX.length).trim() : null;
  const querySecret = searchParams.get("secret");
  const providedSecret = querySecret ?? bearerToken;
  if (providedSecret !== internalSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const deletedEndpoints = await prisma.profileEndpoint.deleteMany({});
    
    const apiKeys = await prisma.apiKey.findMany();
    const allEndpoints = getAllEndpointSlugs();
    let createdCount = 0;

    for (const apiKey of apiKeys) {
      const insertions = allEndpoints.map((ep) => ({
        apiKeyId: apiKey.id,
        endpointSlug: ep.slug,
        enabled: true,
        parameters: null,
      }));

      const result = await prisma.profileEndpoint.createMany({
        data: insertions,
        skipDuplicates: true,
      });
      createdCount += result.count;
    }

    return NextResponse.json({
      success: true,
      message: `Deleted ${deletedEndpoints.count} old endpoints. Created ${createdCount} new endpoints matching SERVICE_REGISTRY.`,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
