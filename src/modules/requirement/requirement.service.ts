import type { TuitionRequirement } from "../../generated/prisma/client.js";
import { unusableAreaIds } from "../../lib/areas.js";
import { DAYS_PER_WEEK_MESSAGE, daysPerWeekFits } from "../../lib/days.js";
import { validateStudentEducation } from "../../lib/education.js";
import { appError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { isPhoneVerificationRequired } from "../phone-verification/phone-verification.policy.js";
import type { CreateRequirementInput, UpdateRequirementInput } from "./requirement.schema.js";

const withSubjects = { subjects: { orderBy: { subjectId: "asc" } } } as const;

function serializeRequirement(
  requirement: TuitionRequirement & { subjects?: { subjectId: number }[] },
) {
  const { subjects, ...rest } = requirement;
  return {
    ...rest,
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
async function assertAreaUsable(areaId: number) {
  const unusable = await unusableAreaIds(prisma, [areaId]);
  if (unusable.length > 0) {
    const err = new Error("Invalid area or subject ID");
    Object.assign(err, { statusCode: 400 });
    throw err;
  }
}

// Posting (status OPEN) needs a verified phone when the student switch is on. Drafts never do.
async function assertPhoneVerifiedToPost(studentId: string) {
  if (!(await isPhoneVerificationRequired("STUDENT"))) return;
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { phoneVerifiedAt: true },
  });
  if (student?.phoneVerifiedAt) return;
  throw appError("PhoneVerificationRequired", 403, "Verify your phone number before posting.");
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
    const created = await prisma.tuitionRequirement.create({
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
      include: withSubjects,
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
    include: withSubjects,
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
    include: withSubjects,
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

  const existing = await prisma.tuitionRequirement.findFirst({
    where: { id, studentId },
    include: withSubjects,
  });
  if (!existing) return null;

  if (!["DRAFT", "OPEN"].includes(existing.status)) {
    const err = new Error("Cannot modify requirement in current status");
    Object.assign(err, { statusCode: 409 });
    throw err;
  }

  // DRAFT -> OPEN is a publish; editing an OPEN requirement is not gated again.
  if (existing.status === "DRAFT" && (data.status ?? existing.status) === "OPEN") {
    await assertPhoneVerifiedToPost(studentId);
  }

  // An area the requirement already has may be inactive; only a newly chosen one is checked.
  if (data.areaId !== undefined && data.areaId !== existing.areaId) {
    await assertAreaUsable(data.areaId);
  }

  // Education is checked on the merged row for every PATCH, not only when publishing.
  // Nullable fields use !== undefined so an explicit null means "clear".
  const education = {
    curriculum: data.curriculum ?? existing.curriculum,
    levelCode: data.levelCode ?? existing.levelCode,
    academicGroup: data.academicGroup !== undefined ? data.academicGroup : existing.academicGroup,
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
      data.subjectIds !== undefined
        ? data.subjectIds
        : existing.subjects?.map((s) => s.subjectId) || [];
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
  }

  const { subjectIds, ...requirementData } = data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
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
        include: withSubjects,
      });
    });

    return serializeRequirement(updated);
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
    include: withSubjects,
  });

  return requirement ? serializeRequirement(requirement) : null;
}
