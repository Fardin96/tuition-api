import { Prisma, type TuitionRequirement } from "../../generated/prisma/client.js";
import { unusableAreaIds } from "../../lib/areas.js";
import { DAYS_PER_WEEK_MESSAGE, daysPerWeekFits } from "../../lib/days.js";
import {
  type AcademicGroup,
  type AdmissionTarget,
  type Curriculum,
  validateStudentEducation,
} from "../../lib/education.js";
import { appError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { isPhoneVerificationRequired } from "../phone-verification/phone-verification.policy.js";
import type { CreateRequirementInput, UpdateRequirementInput } from "./requirement.schema.js";

// A hire is a CONFIRMED or COMPLETED application. FILLED is derived from it, never stored.
const HIRED_STATUSES = ["CONFIRMED", "COMPLETED"] as const;

const requirementInclude = {
  subjects: { orderBy: { subjectId: "asc" } },
  _count: { select: { applications: { where: { status: { in: [...HIRED_STATUSES] } } } } },
} satisfies Prisma.TuitionRequirementInclude;

type RequirementRow = TuitionRequirement & {
  subjects?: { subjectId: number }[];
  _count: { applications: number };
};

function serializeRequirement(requirement: RequirementRow) {
  const { subjects, _count, ...rest } = requirement;
  return {
    ...rest,
    // A hire wins over the stored status, CLOSED included.
    status: _count.applications > 0 ? "FILLED" : rest.status,
    subjectIds: subjects ? subjects.map((s) => s.subjectId) : [],
    timeOfDay: requirement.timeOfDay ? requirement.timeOfDay.toISOString().slice(11, 16) : null,
    hireByDate: requirement.hireByDate ? requirement.hireByDate.toISOString().slice(0, 10) : null,
    createdAt: requirement.createdAt.toISOString(),
    updatedAt: requirement.updatedAt.toISOString(),
  };
}

async function getStudentId(accountId: string) {
  const student = await prisma.student.findUnique({ where: { accountId } });
  return student?.id || null;
}

function handleForeignKeyError(error: unknown): never {
  if ((error as { code?: string }).code === "P2003") {
    const err = new Error("Invalid area or subject ID");
    Object.assign(err, { statusCode: 400 });
    throw err;
  }
  throw error;
}

// Same 400 as an unknown area (P2003), so clients see one message for both.
async function assertAreaUsable(areaId: number, db: Prisma.TransactionClient = prisma) {
  const unusable = await unusableAreaIds(db, [areaId]);
  if (unusable.length > 0) {
    const err = new Error("Invalid area or subject ID");
    Object.assign(err, { statusCode: 400 });
    throw err;
  }
}

// Posting (status OPEN) needs a verified phone when the student switch is on. Drafts never do.
async function assertPhoneVerifiedToPost(studentId: string, db: Prisma.TransactionClient = prisma) {
  if (!(await isPhoneVerificationRequired("STUDENT", db))) return;
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { phoneVerifiedAt: true },
  });
  if (student?.phoneVerifiedAt) return;
  throw appError("PhoneVerificationRequired", 403, "Verify your phone number before posting.");
}

function cannotModify() {
  const err = new Error("Cannot modify requirement in current status");
  Object.assign(err, { statusCode: 409 });
  return err;
}

type DuplicateCandidate = {
  areaId: number;
  curriculum: Curriculum;
  levelCode: number;
  academicGroup: AcademicGroup | null;
  admissionTargets: AdmissionTarget[];
  subjectIds: number[];
};

// One open ask per student: same level, curriculum, group, admission targets, area and subjects.
// Salary, time, days, tuition type, institute, gender and student count do not count.
// Hired requirements and closed ones never block a new post. The advisory lock serializes a
// student's posts and edits, since a unique index cannot see the subject join table.
async function assertNotDuplicate(
  tx: Prisma.TransactionClient,
  studentId: string,
  candidate: DuplicateCandidate,
  excludeId?: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`requirement:${studentId}`}))`;

  const subjectIds = [...new Set(candidate.subjectIds)].sort((a, b) => a - b);
  const admissionTargets = [...candidate.admissionTargets].sort();
  const excludeClause = excludeId ? Prisma.sql`AND r.id <> ${excludeId}::uuid` : Prisma.empty;

  const [found] = await tx.$queryRaw<{ id: string }[]>`
    SELECT r.id
    FROM tuition_requirement r
    WHERE r.student_id = ${studentId}::uuid
      AND r.status = 'OPEN'
      ${excludeClause}
      AND NOT EXISTS (
        SELECT 1 FROM application a
        WHERE a.requirement_id = r.id AND a.status::text IN ('CONFIRMED', 'COMPLETED'))
      AND r.level_code = ${candidate.levelCode}
      AND r.curriculum::text = ${candidate.curriculum}
      AND r.academic_group::text IS NOT DISTINCT FROM ${candidate.academicGroup}
      AND ARRAY(SELECT unnest(r.admission_targets)::text ORDER BY 1) = ${admissionTargets}::text[]
      AND r.area_id = ${candidate.areaId}
      AND ARRAY(
        SELECT rs.subject_id FROM requirement_subject rs
        WHERE rs.requirement_id = r.id ORDER BY 1) = ${subjectIds}::int[]
    LIMIT 1
  `;

  if (found) {
    throw appError(
      "RequirementDuplicate",
      409,
      "You already have an open requirement like this one.",
      { requirementId: found.id },
    );
  }
}

async function notFoundOrConflict(
  id: string,
  studentId: string,
  conflictMessage: string,
): Promise<null> {
  const existing = await prisma.tuitionRequirement.findFirst({
    where: { id, studentId },
  });
  if (existing) {
    const err = new Error(conflictMessage);
    Object.assign(err, { statusCode: 409 });
    throw err;
  }
  return null;
}

export async function createRequirement(accountId: string, data: CreateRequirementInput) {
  const studentId = await getStudentId(accountId);
  if (!studentId) {
    const err = new Error("Student profile not found");
    Object.assign(err, { statusCode: 404 });
    throw err;
  }

  const { subjectIds, ...requirementData } = data;

  if (data.status !== "DRAFT") {
    await assertPhoneVerifiedToPost(studentId);
  }

  const timeOfDayDate = data.timeOfDay ? new Date(`1970-01-01T${data.timeOfDay}:00Z`) : null;
  const hireByDate = data.hireByDate ? new Date(data.hireByDate) : null;

  // Drafts may omit areaId; open requirements always carry one.
  if (data.areaId != null) {
    await assertAreaUsable(data.areaId);
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Drafts are never checked. Posting checks the student's open requirements in this transaction.
      if (data.status === "OPEN") {
        await assertNotDuplicate(tx, studentId, {
          areaId: data.areaId,
          curriculum: data.curriculum,
          levelCode: data.levelCode,
          academicGroup: data.academicGroup ?? null,
          admissionTargets: data.admissionTargets ?? [],
          subjectIds: data.subjectIds,
        });
      }

      return tx.tuitionRequirement.create({
        data: {
          ...requirementData,
          studentId,
          timeOfDay: timeOfDayDate,
          hireByDate,
          subjects:
            subjectIds && subjectIds.length > 0
              ? {
                  createMany: {
                    data: subjectIds.map((id) => ({ subjectId: id })),
                  },
                }
              : undefined,
        },
        include: requirementInclude,
      });
    });
    return serializeRequirement(created);
  } catch (error) {
    handleForeignKeyError(error);
  }
}

export async function getRequirementById(id: string, accountId: string) {
  const studentId = await getStudentId(accountId);
  if (!studentId) return null;

  const requirement = await prisma.tuitionRequirement.findUnique({
    where: {
      id,
      studentId,
    },
    include: requirementInclude,
  });

  return requirement ? serializeRequirement(requirement) : null;
}

export async function getRequirementsForStudent(accountId: string) {
  const studentId = await getStudentId(accountId);
  if (!studentId) return [];

  const requirements = await prisma.tuitionRequirement.findMany({
    where: {
      studentId,
    },
    include: requirementInclude,
    orderBy: {
      createdAt: "desc",
    },
  });

  return requirements.map(serializeRequirement);
}

export async function updateRequirement(
  id: string,
  accountId: string,
  data: UpdateRequirementInput,
) {
  const studentId = await getStudentId(accountId);
  if (!studentId) return null;

  const { subjectIds, ...requirementData } = data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      // Same lock order as the duplicate guard: the student's advisory lock, then the row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`requirement:${studentId}`}))`;
      // Confirming an application locks this row too, so an edit and a hire cannot interleave.
      await tx.$queryRaw`
        SELECT 1 FROM tuition_requirement
        WHERE id = ${id}::uuid AND student_id = ${studentId}::uuid
        FOR UPDATE
      `;

      const existing = await tx.tuitionRequirement.findFirst({
        where: { id, studentId },
        include: requirementInclude,
      });
      if (!existing) return null;

      // A hired requirement is locked for edits, whatever its stored status.
      if (!["DRAFT", "OPEN"].includes(existing.status) || existing._count.applications > 0) {
        throw cannotModify();
      }

      // DRAFT -> OPEN is a publish; editing an OPEN requirement is not gated again.
      if (existing.status === "DRAFT" && (data.status ?? existing.status) === "OPEN") {
        await assertPhoneVerifiedToPost(studentId, tx);
      }

      // An area the requirement already has may be inactive; only a newly chosen one is checked.
      if (data.areaId !== undefined && data.areaId !== existing.areaId) {
        await assertAreaUsable(data.areaId, tx);
      }

      // Education is checked on the merged row for every PATCH, not only when publishing.
      // Nullable fields use !== undefined so an explicit null means "clear".
      const education = {
        curriculum: data.curriculum ?? existing.curriculum,
        levelCode: data.levelCode ?? existing.levelCode,
        academicGroup:
          data.academicGroup !== undefined ? data.academicGroup : existing.academicGroup,
        admissionTargets: data.admissionTargets ?? existing.admissionTargets,
        isRetaker: data.isRetaker ?? existing.isRetaker,
        levelNote: data.levelNote !== undefined ? data.levelNote : existing.levelNote,
      };
      const educationIssues = validateStudentEducation(education);
      if (educationIssues.length > 0) {
        throw appError("InvalidRequirement", 400, educationIssues[0].message, {
          fields: educationIssues.map((i) => i.path),
        });
      }

      const daysPerWeek = data.daysPerWeek ?? existing.daysPerWeek;
      const availableDays = data.availableDays ?? existing.availableDays;
      if (!daysPerWeekFits(daysPerWeek, availableDays)) {
        throw appError("InvalidRequirement", 400, DAYS_PER_WEEK_MESSAGE, {
          fields: ["daysPerWeek"],
        });
      }

      const targetStatus = data.status ?? existing.status;
      if (targetStatus === "OPEN") {
        const candidateSubjects =
          subjectIds !== undefined ? subjectIds : existing.subjects?.map((s) => s.subjectId) || [];
        const candidate = {
          curriculum: education.curriculum,
          areaId: data.areaId ?? existing.areaId,
          levelCode: education.levelCode,
          timeOfDay: data.timeOfDay !== undefined ? data.timeOfDay : existing.timeOfDay,
          daysPerWeek,
          salary: data.salary ?? existing.salary,
          hireByDate: data.hireByDate !== undefined ? data.hireByDate : existing.hireByDate,
          tuitionType: data.tuitionType ?? existing.tuitionType,
        };

        if (
          candidate.curriculum == null ||
          candidate.areaId == null ||
          candidateSubjects.length === 0 ||
          candidate.levelCode == null ||
          candidate.timeOfDay == null ||
          candidate.daysPerWeek == null ||
          candidate.salary == null ||
          candidate.hireByDate == null ||
          candidate.tuitionType == null
        ) {
          const err = new Error(
            "Cannot publish incomplete requirement: all fields are required to open",
          );
          Object.assign(err, { statusCode: 400 });
          throw err;
        }

        // Only a publish or a change to what identifies the ask is checked, so twins that already
        // exist can still edit their salary or time.
        const sameSet = (a: readonly (number | string)[], b: readonly (number | string)[]) =>
          a.length === b.length && [...a].sort().join() === [...b].sort().join();
        const identityChanged =
          existing.status === "DRAFT" ||
          candidate.areaId !== existing.areaId ||
          candidate.curriculum !== existing.curriculum ||
          candidate.levelCode !== existing.levelCode ||
          education.academicGroup !== existing.academicGroup ||
          !sameSet(education.admissionTargets, existing.admissionTargets) ||
          !sameSet(candidateSubjects, existing.subjects?.map((s) => s.subjectId) ?? []);
        if (identityChanged) {
          await assertNotDuplicate(
            tx,
            studentId,
            {
              areaId: candidate.areaId,
              curriculum: candidate.curriculum,
              levelCode: candidate.levelCode,
              academicGroup: education.academicGroup,
              admissionTargets: education.admissionTargets,
              subjectIds: candidateSubjects,
            },
            id,
          );
        }
      }

      if (subjectIds !== undefined) {
        await tx.requirementSubject.deleteMany({
          where: { requirementId: id },
        });

        if (subjectIds.length > 0) {
          await tx.requirementSubject.createMany({
            data: subjectIds.map((sid) => ({ requirementId: id, subjectId: sid })),
          });
        }
      }

      return tx.tuitionRequirement.update({
        where: { id },
        data: {
          ...requirementData,
          timeOfDay: data.timeOfDay ? new Date(`1970-01-01T${data.timeOfDay}:00Z`) : undefined,
          hireByDate: data.hireByDate ? new Date(data.hireByDate) : undefined,
        },
        include: requirementInclude,
      });
    });

    return updated ? serializeRequirement(updated) : null;
  } catch (error) {
    handleForeignKeyError(error);
  }
}

export async function closeRequirement(id: string, accountId: string) {
  const studentId = await getStudentId(accountId);
  if (!studentId) return null;

  const result = await prisma.tuitionRequirement.updateMany({
    where: {
      id,
      studentId,
      status: { in: ["DRAFT", "OPEN"] },
    },
    data: {
      status: "CLOSED",
    },
  });

  if (result.count === 0) {
    return notFoundOrConflict(id, studentId, "Cannot close requirement in current status");
  }

  const requirement = await prisma.tuitionRequirement.findUnique({
    where: { id },
    include: requirementInclude,
  });

  return requirement ? serializeRequirement(requirement) : null;
}
