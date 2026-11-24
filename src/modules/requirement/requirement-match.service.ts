import { Prisma } from "../../generated/prisma/client.js";
import { avatarSelect, avatarUrlFor } from "../../lib/avatar.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { tutorBadges } from "../../lib/profile-strength.js";
import { MATCH_LIST_CAP, recommendTutors, studentSuggestions } from "../matching/match.service.js";
import { reasonsFor } from "../matching/match-reasons.js";
import { getMatchingConfig } from "../matching/matching-config.js";
import type {
  RecommendedTutorPageResponse,
  RequirementInviteResponse,
} from "./requirement-match.schema.js";

const PAGE_SIZE = 20;
const INVITE_LIMIT = 20;
const CLOSED_STATUSES = ["CONFIRMED", "COMPLETED"] as const;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// The caller's own requirement. Anyone else's, and an unknown id, get the same 404.
async function ownRequirement(accountId: string, requirementId: string) {
  const student = await prisma.student.findUnique({
    where: { accountId },
    select: { id: true },
  });
  const requirement = student
    ? await prisma.tuitionRequirement.findFirst({
        where: { id: requirementId, studentId: student.id },
        select: { id: true, status: true, tuitionType: true, tutorGenderPref: true },
      })
    : null;
  if (!requirement) throw notFound("Requirement not found");
  return requirement;
}

// Listed tutors whose best set matches the student's requirement, best score first. The score
// stays server-side: students get the reasons and the tutor card, not a number.
export async function listRecommendedTutors(
  accountId: string,
  requirementId: string,
  page: number,
): Promise<RecommendedTutorPageResponse> {
  const requirement = await ownRequirement(accountId, requirementId);
  if (requirement.status !== "OPEN") {
    throw appError("ListingNotOpen", 409, "This listing is no longer open");
  }

  const cfg = await getMatchingConfig();
  const offset = (page - 1) * PAGE_SIZE;
  const { rows, total } = await recommendTutors(cfg, requirementId, offset, PAGE_SIZE);
  const tutorIds = rows.map((row) => row.tutorId);

  const [tutors, invites, applications, badges] = await Promise.all([
    tutorIds.length
      ? prisma.tutor.findMany({
          where: { id: { in: tutorIds } },
          select: {
            id: true,
            name: true,
            instituteName: true,
            gender: true,
            ratingAvg: true,
            ratingCount: true,
            verificationStatus: true,
            account: { select: avatarSelect },
            areas: {
              select: { area: { select: { id: true, name: true } } },
              orderBy: { areaId: "asc" },
            },
            subjects: {
              select: { subject: { select: { id: true, name: true } } },
              orderBy: { subjectId: "asc" },
            },
          },
        })
      : Promise.resolve([]),
    tutorIds.length
      ? prisma.requirementInvite.findMany({
          where: { requirementId, tutorId: { in: tutorIds } },
          select: { tutorId: true, createdAt: true },
        })
      : Promise.resolve([]),
    tutorIds.length
      ? prisma.application.findMany({
          where: { requirementId, tutorId: { in: tutorIds } },
          select: { id: true, tutorId: true, status: true },
        })
      : Promise.resolve([]),
    tutorBadges(prisma, tutorIds),
  ]);

  const tutorById = new Map(tutors.map((t) => [t.id, t]));
  const avatarById = new Map(
    await Promise.all(tutors.map(async (t) => [t.id, await avatarUrlFor(t.account)] as const)),
  );
  const invitedAt = new Map(invites.map((i) => [i.tutorId, i.createdAt]));
  const applicationBy = new Map(
    applications.map((a) => [a.tutorId, { id: a.id, status: a.status }]),
  );

  // The ranked order from the engine is the page order.
  const list = rows.flatMap((row) => {
    const tutor = tutorById.get(row.tutorId);
    if (!tutor) return [];
    return [
      {
        tutor: {
          id: tutor.id,
          name: tutor.name,
          instituteName: tutor.instituteName,
          gender: tutor.gender,
          ratingAvg: Number(tutor.ratingAvg),
          ratingCount: tutor.ratingCount,
          verificationStatus: tutor.verificationStatus,
          verifiedBadge: badges.get(tutor.id) ?? false,
          avatarUrl: avatarById.get(tutor.id) ?? null,
          areas: tutor.areas.map((a) => a.area),
          subjects: tutor.subjects.map((s) => s.subject),
        },
        reasons: reasonsFor(row, cfg, "STUDENT"),
        invitedAt: invitedAt.get(row.tutorId) ?? null,
        application: applicationBy.get(row.tutorId) ?? null,
      },
    ];
  });

  return {
    tutors: list,
    total,
    page,
    hasMore: offset + rows.length < Math.min(total, MATCH_LIST_CAP),
    matchVersion: cfg.version,
    suggestions:
      total < 3
        ? await studentSuggestions(
            cfg,
            {
              id: requirementId,
              tuitionType: requirement.tuitionType,
              tutorGenderPref: requirement.tutorGenderPref,
            },
            total,
          )
        : [],
  };
}

// The student invites a listed tutor. No match is needed: the student may invite any listed tutor.
// The requirement row is locked so the 20-invite limit holds under concurrent invites.
export async function inviteTutor(
  accountId: string,
  requirementId: string,
  tutorId: string,
): Promise<RequirementInviteResponse> {
  const student = await prisma.student.findUnique({
    where: { accountId },
    select: { id: true },
  });
  if (!student) throw notFound("Requirement not found");

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tuition_requirement WHERE id = ${requirementId}::uuid FOR UPDATE`;

    const requirement = await tx.tuitionRequirement.findFirst({
      where: { id: requirementId, studentId: student.id },
      select: { status: true },
    });
    if (!requirement) throw notFound("Requirement not found");

    const tutor = await tx.tutor.findFirst({
      where: { id: tutorId, isListed: true },
      select: { id: true, accountId: true },
    });
    if (!tutor) throw notFound("Tutor not found");

    if (requirement.status !== "OPEN") {
      throw appError("ListingNotOpen", 409, "This listing is no longer open");
    }

    const closed = await tx.application.count({
      where: { requirementId, status: { in: [...CLOSED_STATUSES] } },
    });
    if (closed > 0) {
      throw appError("ApplicationClosed", 409, "This tuition is no longer taking applications");
    }

    const applied = await tx.application.findFirst({
      where: { requirementId, tutorId },
      select: { id: true },
    });
    if (applied) throw appError("AlreadyApplied", 409, "This tutor already applied");

    const invited = await tx.requirementInvite.findFirst({
      where: { requirementId, tutorId },
      select: { id: true },
    });
    if (invited) throw appError("InviteExists", 409, "You already invited this tutor");

    const invites = await tx.requirementInvite.count({ where: { requirementId } });
    if (invites >= INVITE_LIMIT) {
      throw appError(
        "InviteLimitReached",
        409,
        `You can invite up to ${INVITE_LIMIT} tutors to one requirement`,
      );
    }

    let invite: { id: string; requirementId: string; tutorId: string; createdAt: Date };
    try {
      invite = await tx.requirementInvite.create({
        data: { requirementId, tutorId, studentId: student.id },
        select: { id: true, requirementId: true, tutorId: true, createdAt: true },
      });
    } catch (error) {
      // Race: a concurrent invite won the (requirement_id, tutor_id) unique index.
      if (isUniqueViolation(error))
        throw appError("InviteExists", 409, "You already invited this tutor");
      throw error;
    }

    await tx.appNotification.create({
      data: { recipientId: tutor.accountId, kind: "REQUIREMENT_INVITED", requirementId },
    });
    return invite;
  });
}
