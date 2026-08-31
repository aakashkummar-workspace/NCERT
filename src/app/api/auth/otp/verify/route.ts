/**
 * POST /api/auth/otp/verify/  — exchange a code for a session cookie.
 *
 * Creates the account if the phone has none. Note what is *not* in the body
 * validator: `role`, `scopeId`, `hitlEnabled`, `userId`. Every one of those is
 * a privilege, and a privilege accepted from a request body is a privilege
 * granted to anyone with curl. New accounts are STUDENT, in the public scope,
 * with HITL off — see the note in src/lib/auth.ts.
 */
import { NextResponse } from "next/server";
import { route, v } from "@/lib/api";
import { verifyOtp } from "@/lib/auth";
import { startSession } from "@/lib/session";

export const POST = route(
  {
    body: v.object({
      challenge: v.string({ min: 1, max: 2048 }),
      code: v.string({ min: 4, max: 12 }),
      displayName: v.optional(v.string({ min: 1, max: 120 })),
      classNum: v.optional(v.int({ min: 9, max: 10 })),
    }),
  },
  async ({ body }) => {
    const { user, isNewUser } = await verifyOtp(body);
    const session = await startSession(user);
    return NextResponse.json(
      {
        isNewUser,
        user: {
          id: user.id,
          phone: user.phone,
          displayName: user.displayName,
          role: user.role,
          scopeId: user.scopeId,
        },
        expiresAt: session.expiresAt.toISOString(),
      },
      { status: isNewUser ? 201 : 200 },
    );
  },
);
