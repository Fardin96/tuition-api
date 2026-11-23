import { z } from "zod";

// Counts for the dashboard "At a glance" row. The tutor's rating is not here: /me already carries ratingAvg and ratingCount.
export const tutorStatsSchema = z
  .object({
    role: z.literal("TUTOR"),
    applicationsSent: z.number().int(),
    activeStudents: z.number().int(),
    invitesReceived: z.number().int(),
  })
  .meta({ id: "TutorStats" });

export const studentStatsSchema = z
  .object({
    role: z.literal("STUDENT"),
    openRequirements: z.number().int(),
    applicationsReceived: z.number().int(),
    tutorsHired: z.number().int(),
  })
  .meta({ id: "StudentStats" });

export const myStatsSchema = z
  .discriminatedUnion("role", [tutorStatsSchema, studentStatsSchema])
  .meta({ id: "MyStats" });

export type MyStatsResponse = z.infer<typeof myStatsSchema>;
