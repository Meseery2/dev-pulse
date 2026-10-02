import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSquadView } from "@/lib/data/views";
import { AuthorizationError } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: RouteContext<"/api/metrics/squad/[squadId]">) {
  const { squadId } = await context.params;
  try {
    const view = await getSquadView(squadId);
    return NextResponse.json(view);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
