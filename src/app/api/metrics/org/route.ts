import { NextResponse } from "next/server";
import { getExecView } from "@/lib/data/views";
import { AuthorizationError } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

/**
 * The JSON API enforces exactly the same guards as the pages. Authorization
 * lives in the data access layer, so there is no route that can serve this
 * payload without passing the role check.
 */
export async function GET() {
  try {
    const view = await getExecView();
    return NextResponse.json(view);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
