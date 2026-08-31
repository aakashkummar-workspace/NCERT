/**
 * GET /api/auth/session/  — who am I?
 *
 * 401 when signed out, which is a normal answer and not an error worth logging.
 * The client uses it to decide whether to show the sign-in sheet.
 *
 * It returns the row rather than the cookie's claims, so a role changed by an
 * admin five seconds ago is the role reported here.
 */
import { route } from "@/lib/api";
import prisma from "@/lib/db";

export const GET = route({ auth: "any" }, async ({ user }) => {
  const profiles = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      studentProfile: { select: { classNum: true, schoolName: true, language: true } },
      evaluatorProfile: {
        select: {
          evaluatorType: true,
          activeForRouting: true,
          maxConcurrent: true,
          subjects: { select: { subject: true, classNum: true } },
        },
      },
    },
  });

  return {
    user: {
      id: user.id,
      phone: user.phone,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      scopeId: user.scopeId,
      hitlEnabled: user.hitlEnabled,
    },
    studentProfile: profiles?.studentProfile ?? null,
    evaluatorProfile: profiles?.evaluatorProfile ?? null,
  };
});
