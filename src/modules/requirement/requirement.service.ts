import type { TuitionRequirement } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { CreateRequirementInput, UpdateRequirementInput } from "./requirement.schema.js";

function serializeRequirement(requirement: TuitionRequirement) {
  return {
    ...requirement,
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
    const err = new Error("Invalid category, area, or subject ID");
    Object.assign(err, { statusCode: 400 });
    throw err;
  }
  throw error;
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

  const timeOfDayDate = data.timeOfDay ? new Date(`1970-01-01T${data.timeOfDay}:00Z`) : null;
  const hireByDate = data.hireByDate ? new Date(data.hireByDate) : null;

  try {
    const created = await prisma.tuitionRequirement.create({
      data: {
        ...data,
        studentId,
        timeOfDay: timeOfDayDate,
        hireByDate,
      },
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
  });
  if (!existing) return null;

  if (!["DRAFT", "OPEN"].includes(existing.status)) {
    const err = new Error("Cannot modify requirement in current status");
    Object.assign(err, { statusCode: 409 });
    throw err;
  }

  const targetStatus = data.status ?? existing.status;
  if (targetStatus === "OPEN") {
    const candidate = {
      categoryId: data.categoryId ?? existing.categoryId,
      areaId: data.areaId ?? existing.areaId,
      subjectId: data.subjectId ?? existing.subjectId,
      classLevel: data.classLevel ?? existing.classLevel,
      timeOfDay: data.timeOfDay !== undefined ? data.timeOfDay : existing.timeOfDay,
      daysPerWeek: data.daysPerWeek ?? existing.daysPerWeek,
      salary: data.salary ?? existing.salary,
      hireByDate: data.hireByDate !== undefined ? data.hireByDate : existing.hireByDate,
      tuitionType: data.tuitionType ?? existing.tuitionType,
    };

    if (
      candidate.categoryId == null ||
      candidate.areaId == null ||
      candidate.subjectId == null ||
      candidate.classLevel == null ||
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

  try {
    const updated = await prisma.tuitionRequirement.update({
      where: { id },
      data: {
        ...data,
        timeOfDay: data.timeOfDay ? new Date(`1970-01-01T${data.timeOfDay}:00Z`) : undefined,
        hireByDate: data.hireByDate ? new Date(data.hireByDate) : undefined,
      },
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
  });

  return requirement ? serializeRequirement(requirement) : null;
}
