import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../auth/auth.schema.js";
import type { MyStatsResponse } from "./stats.schema.js";

// Keyed by account id, so an account without a profile reads as zeros.
export async function getMyStats(caller: AuthContext): Promise<MyStatsResponse> {
  return caller.role === "TUTOR" ? tutorStats(caller.accountId) : studentStats(caller.accountId);
}

async function tutorStats(accountId: string): Promise<MyStatsResponse> {
  const [applicationsSent, activeStudents, invitesReceived] = await Promise.all([
    prisma.application.count({ where: { initiatedBy: "TUTOR", tutor: { accountId } } }),
    // Distinct students: a second CONFIRMED application to the same student counts once.
    prisma.application
      .groupBy({ by: ["studentId"], where: { status: "CONFIRMED", tutor: { accountId } } })
      .then((rows) => rows.length),
    // Same filter as scope=invited in the requirement browse list.
    prisma.requirementInvite.count({
      where: {
        tutor: { accountId },
        requirement: { status: "OPEN" },
        student: { account: { status: "ACTIVE" } },
      },
    }),
  ]);
  return { role: "TUTOR", applicationsSent, activeStudents, invitesReceived };
}

async function studentStats(accountId: string): Promise<MyStatsResponse> {
  const [openRequirements, applicationsReceived, tutorsHired] = await Promise.all([
    prisma.tuitionRequirement.count({ where: { status: "OPEN", student: { accountId } } }),
    prisma.application.count({ where: { initiatedBy: "TUTOR", student: { accountId } } }),
    prisma.application
      .groupBy({
        by: ["tutorId"],
        where: { status: { in: ["CONFIRMED", "COMPLETED"] }, student: { accountId } },
      })
      .then((rows) => rows.length),
  ]);
  return { role: "STUDENT", openRequirements, applicationsReceived, tutorsHired };
}
