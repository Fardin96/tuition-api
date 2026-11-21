import { describe, expect, it } from "vitest";
import { Prisma } from "../../generated/prisma/client.js";
import {
  type AcademicGroup,
  type AdmissionTarget,
  type Curriculum,
  matchesTutorSet,
} from "../../lib/education.js";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createArea,
  createRequirement,
  createStudentProfile,
  createTutorProfile,
  createTutorRequirement,
} from "../../tests/helpers.js";
import { pairSql } from "./match-sql.js";
import { DEFAULT_MATCHING_CONFIG } from "./matching-config.js";

// The student side of the set check (src/lib/education.ts) and the SQL engine must agree on the
// three education rules, or the browse and the application code would disagree.

type RequirementCase = {
  curriculum: Curriculum | null;
  levelCode: number;
  academicGroup: AcademicGroup | null;
  admissionTargets: AdmissionTarget[];
  status?: "DRAFT";
};

type SetCase = {
  levelMin: number;
  levelMax: number;
  curricula: Curriculum[];
  academicGroups: AcademicGroup[];
  admissionTargets: AdmissionTarget[];
};

const REQUIREMENTS: RequirementCase[] = [
  { curriculum: "BANGLA_MEDIUM", levelCode: 8, academicGroup: null, admissionTargets: [] },
  { curriculum: "ENGLISH_VERSION", levelCode: 10, academicGroup: "SCIENCE", admissionTargets: [] },
  {
    curriculum: "EM_CAMBRIDGE",
    levelCode: 13,
    academicGroup: null,
    admissionTargets: ["ENGINEERING"],
  },
  {
    curriculum: "BANGLA_MEDIUM",
    levelCode: 13,
    academicGroup: null,
    admissionTargets: ["MEDICAL"],
  },
  { curriculum: "MADRASAH", levelCode: 11, academicGroup: "HUMANITIES", admissionTargets: [] },
  { curriculum: null, levelCode: 8, academicGroup: null, admissionTargets: [], status: "DRAFT" },
];

const SETS: SetCase[] = [
  {
    levelMin: 6,
    levelMax: 10,
    curricula: ["BANGLA_MEDIUM", "ENGLISH_VERSION"],
    academicGroups: [],
    admissionTargets: [],
  },
  {
    levelMin: 9,
    levelMax: 12,
    curricula: ["ENGLISH_VERSION"],
    academicGroups: ["SCIENCE"],
    admissionTargets: [],
  },
  {
    levelMin: 1,
    levelMax: 13,
    curricula: ["EM_CAMBRIDGE"],
    academicGroups: [],
    admissionTargets: ["ENGINEERING", "MEDICAL"],
  },
  {
    levelMin: 11,
    levelMax: 13,
    curricula: ["BANGLA_MEDIUM", "MADRASAH"],
    academicGroups: ["HUMANITIES"],
    admissionTargets: ["MEDICAL"],
  },
];

describe("matching parity: pairSql vs matchesTutorSet", () => {
  it("pass_curriculum, pass_level and pass_groupTarget agree with matchesTutorSet on every requirement and set", async () => {
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const student = await createStudentProfile(account.id, area.id);
    const tutorAccount = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(tutorAccount.id);

    const requirementCases = new Map<string, RequirementCase>();
    for (const c of REQUIREMENTS) {
      const row = await createRequirement({ studentId: student.id, ...c });
      requirementCases.set(row.id, c);
    }
    const setCases = new Map<string, SetCase>();
    for (const [i, c] of SETS.entries()) {
      const row = await createTutorRequirement(tutor.id, { name: `Set ${i}`, ...c });
      setCases.set(row.id, c);
    }

    const rows = await prisma.$queryRaw<
      {
        requirementId: string;
        setId: string;
        pass_curriculum: boolean;
        pass_level: boolean;
        pass_groupTarget: boolean;
      }[]
    >(
      pairSql(
        { ...DEFAULT_MATCHING_CONFIG, admissionIgnoresCurriculum: false },
        { where: Prisma.sql`TRUE` },
      ),
    );

    expect(rows).toHaveLength(REQUIREMENTS.length * SETS.length);
    const verdicts = rows.map((row) => {
      const r = requirementCases.get(row.requirementId);
      const t = setCases.get(row.setId);
      if (!r || !t) throw new Error("unknown pair");
      return {
        expected: matchesTutorSet(r, t),
        actual: row.pass_curriculum && row.pass_level && row.pass_groupTarget,
      };
    });
    for (const verdict of verdicts) expect(verdict.actual).toBe(verdict.expected);
    // The grid must cover both answers, or the comparison proves little.
    expect(verdicts.some((v) => v.expected)).toBe(true);
    expect(verdicts.some((v) => !v.expected)).toBe(true);
  });
});
