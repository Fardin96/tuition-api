import { describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma.js";
import {
  createAccount,
  createArea,
  createStudentProfile,
  createTutorProfile,
} from "../tests/helpers.js";
import {
  ACADEMIC_GROUPS,
  type AcademicGroup,
  ADMISSION_TARGETS,
  type AdmissionTarget,
  CURRICULA,
  type Curriculum,
  type EducationIssue,
  educationLookup,
  matchesTutorSet,
  normalizeLevelNote,
  type StudentEducation,
  type TutorCoverage,
  validateStudentEducation,
  validateTutorCoverage,
} from "./education.js";

const NOT_OFFERED = "This level is not offered for this curriculum";
const RANGE_MESSAGE = "Level must be between -4 and 13";

function student(overrides: Partial<StudentEducation> = {}): StudentEducation {
  return {
    curriculum: "EM_CAMBRIDGE",
    levelCode: 5,
    academicGroup: null,
    admissionTargets: [],
    isRetaker: false,
    levelNote: null,
    ...overrides,
  };
}

function messages(issues: EducationIssue[]) {
  return issues.map((i) => i.message);
}

describe("validateStudentEducation", () => {
  it("accepts the boundaries -4 and 13 and rejects -5 and 14", () => {
    expect(validateStudentEducation(student({ levelCode: -5 }))).toEqual([
      { path: "levelCode", message: RANGE_MESSAGE },
    ]);
    expect(validateStudentEducation(student({ levelCode: -4 }))).toEqual([]);
    expect(validateStudentEducation(student({ levelCode: 0 }))).toEqual([]);
    expect(
      validateStudentEducation(student({ levelCode: 13, admissionTargets: ["MEDICAL"] })),
    ).toEqual([]);
    expect(validateStudentEducation(student({ levelCode: 14 }))).toEqual([
      { path: "levelCode", message: RANGE_MESSAGE },
    ]);
  });

  it("hides levels a curriculum does not offer", () => {
    // Madrasah has no -2 level.
    expect(
      messages(validateStudentEducation(student({ curriculum: "MADRASAH", levelCode: -2 }))),
    ).toEqual([NOT_OFFERED]);
    // IB has no 0 level.
    expect(
      messages(validateStudentEducation(student({ curriculum: "EM_IB", levelCode: 0 }))),
    ).toEqual([NOT_OFFERED]);
  });

  it("rejects a group outside levels 9 to 12", () => {
    const issues = validateStudentEducation(
      student({ curriculum: "BANGLA_MEDIUM", levelCode: 8, academicGroup: "SCIENCE" }),
    );
    expect(issues).toEqual([
      { path: "academicGroup", message: "A group only applies to levels 9 to 12" },
    ]);
  });

  it("rejects a group when the level is null", () => {
    const issues = validateStudentEducation(
      student({ curriculum: "BANGLA_MEDIUM", levelCode: null, academicGroup: "SCIENCE" }),
    );
    expect(issues).toEqual([
      { path: "academicGroup", message: "A group only applies to levels 9 to 12" },
    ]);
  });

  it("rejects a group the curriculum does not offer", () => {
    expect(
      validateStudentEducation(
        student({ curriculum: "EM_CAMBRIDGE", levelCode: 10, academicGroup: "SCIENCE" }),
      ),
    ).toEqual([
      { path: "academicGroup", message: "This group is not offered for this curriculum" },
    ]);
    expect(
      validateStudentEducation(
        student({ curriculum: "MADRASAH", levelCode: 10, academicGroup: "BUSINESS" }),
      ),
    ).toEqual([
      { path: "academicGroup", message: "This group is not offered for this curriculum" },
    ]);
  });

  it("accepts a group the curriculum offers at levels 9 to 12", () => {
    expect(
      validateStudentEducation(
        student({ curriculum: "MADRASAH", levelCode: 9, academicGroup: "MUJABBID" }),
      ),
    ).toEqual([]);
  });

  it("allows admission targets only at level 13", () => {
    expect(
      validateStudentEducation(student({ levelCode: 12, admissionTargets: ["MEDICAL"] })),
    ).toEqual([{ path: "admissionTargets", message: "Admission targets only apply to level 13" }]);
    expect(
      validateStudentEducation(student({ levelCode: 13, admissionTargets: ["MEDICAL"] })),
    ).toEqual([]);
  });

  it("rejects duplicate admission targets", () => {
    expect(
      validateStudentEducation(
        student({ levelCode: 13, admissionTargets: ["MEDICAL", "MEDICAL"] }),
      ),
    ).toEqual([{ path: "admissionTargets", message: "Admission targets must be unique" }]);
  });

  it("allows retaking only at levels 10, 12 and 13", () => {
    for (let level = -4; level <= 13; level++) {
      const issues = validateStudentEducation(student({ levelCode: level, isRetaker: true }));
      const retakerIssues = issues.filter((i) => i.path === "isRetaker");
      const allowed = level === 10 || level === 12 || level === 13;
      expect(retakerIssues.length, `level ${level}`).toBe(allowed ? 0 : 1);
    }
    expect(
      validateStudentEducation(
        student({ curriculum: "EM_CAMBRIDGE", levelCode: null, isRetaker: true }),
      ),
    ).toEqual([{ path: "isRetaker", message: "Retaking only applies to levels 10, 12 and 13" }]);
  });

  it("accepts a level note of 40 characters and rejects 41", () => {
    const forty = "a".repeat(40);
    const fortyOne = "a".repeat(41);
    expect(validateStudentEducation(student({ levelNote: forty }))).toEqual([]);
    expect(validateStudentEducation(student({ levelNote: fortyOne }))).toEqual([
      { path: "levelNote", message: "Keep the note under 41 characters" },
    ]);
  });
});

describe("normalizeLevelNote", () => {
  it("returns null for null and undefined", () => {
    expect(normalizeLevelNote(null)).toBeNull();
    expect(normalizeLevelNote(undefined)).toBeNull();
  });

  it("returns null for empty and whitespace-only input", () => {
    expect(normalizeLevelNote("")).toBeNull();
    expect(normalizeLevelNote("   ")).toBeNull();
  });

  it("trims and collapses whitespace", () => {
    expect(normalizeLevelNote("\tA \n b ")).toBe("A b");
  });

  it("replaces control characters with spaces", () => {
    expect(normalizeLevelNote("a\u0000b\u0007c\u007fd")).toBe("a b c d");
  });
});

describe("validateTutorCoverage", () => {
  const base: TutorCoverage = {
    levelMin: 1,
    levelMax: 8,
    curricula: ["BANGLA_MEDIUM"],
    academicGroups: [],
    admissionTargets: [],
  };

  it("rejects an inverted level range", () => {
    expect(validateTutorCoverage({ ...base, levelMin: 9, levelMax: 8 })).toEqual([
      { path: "levelMax", message: "Levels must run from low to high within -4 to 13" },
    ]);
  });

  it("requires at least one curriculum", () => {
    expect(validateTutorCoverage({ ...base, curricula: [] })).toEqual([
      { path: "curricula", message: "Pick at least one curriculum" },
    ]);
  });

  it("rejects groups when the range does not touch levels 9 to 12", () => {
    expect(validateTutorCoverage({ ...base, academicGroups: ["SCIENCE"] })).toEqual([
      { path: "academicGroups", message: "Groups only apply when the range covers levels 9 to 12" },
    ]);
  });

  it("rejects BUSINESS when only Madrasah is chosen", () => {
    expect(
      validateTutorCoverage({
        levelMin: 9,
        levelMax: 12,
        curricula: ["MADRASAH"],
        academicGroups: ["BUSINESS"],
        admissionTargets: [],
      }),
    ).toEqual([
      { path: "academicGroups", message: "Each group must belong to a chosen curriculum" },
    ]);
  });

  it("rejects MUJABBID when only Bangla medium is chosen", () => {
    expect(
      validateTutorCoverage({
        levelMin: 9,
        levelMax: 12,
        curricula: ["BANGLA_MEDIUM"],
        academicGroups: ["MUJABBID"],
        admissionTargets: [],
      }),
    ).toEqual([
      { path: "academicGroups", message: "Each group must belong to a chosen curriculum" },
    ]);
  });

  it("rejects admission targets when the range stops short of level 13", () => {
    expect(
      validateTutorCoverage({ ...base, levelMin: 9, levelMax: 12, admissionTargets: ["MEDICAL"] }),
    ).toEqual([
      { path: "admissionTargets", message: "Admission targets need the range to reach level 13" },
    ]);
  });

  it("rejects duplicate values in each list", () => {
    expect(
      validateTutorCoverage({ ...base, curricula: ["BANGLA_MEDIUM", "BANGLA_MEDIUM"] }),
    ).toEqual([{ path: "curricula", message: "Values must be unique" }]);
    expect(
      validateTutorCoverage({
        ...base,
        levelMin: 9,
        levelMax: 13,
        curricula: ["MADRASAH"],
        academicGroups: ["SCIENCE", "SCIENCE"],
      }),
    ).toEqual([{ path: "academicGroups", message: "Values must be unique" }]);
    expect(
      validateTutorCoverage({ ...base, levelMax: 13, admissionTargets: ["ISSB", "ISSB"] }),
    ).toEqual([{ path: "admissionTargets", message: "Values must be unique" }]);
  });

  it("accepts a full-range set", () => {
    expect(
      validateTutorCoverage({
        levelMin: -4,
        levelMax: 13,
        curricula: [...CURRICULA],
        academicGroups: [...ACADEMIC_GROUPS],
        admissionTargets: [...ADMISSION_TARGETS],
      }),
    ).toEqual([]);
  });
});

describe("matchesTutorSet", () => {
  const request = {
    curriculum: "BANGLA_MEDIUM" as Curriculum,
    levelCode: 9,
    academicGroup: null as AcademicGroup | null,
    admissionTargets: [] as AdmissionTarget[],
  };
  const tutor: TutorCoverage = {
    levelMin: 1,
    levelMax: 12,
    curricula: ["BANGLA_MEDIUM"],
    academicGroups: [],
    admissionTargets: [],
  };

  it("does not match a different curriculum", () => {
    expect(matchesTutorSet({ ...request, curriculum: "ENGLISH_VERSION" }, tutor)).toBe(false);
  });

  it("does not match a level outside the tutor range", () => {
    expect(matchesTutorSet({ ...request, levelCode: 13 }, tutor)).toBe(false);
    expect(matchesTutorSet({ ...request, levelCode: 0 }, tutor)).toBe(false);
    expect(matchesTutorSet({ ...request, levelCode: 1 }, tutor)).toBe(true);
    expect(matchesTutorSet({ ...request, levelCode: 12 }, tutor)).toBe(true);
  });

  it("treats empty tutor groups as any group", () => {
    expect(matchesTutorSet({ ...request, academicGroup: "BUSINESS" }, tutor)).toBe(true);
  });

  it("does not match a group the tutor does not cover", () => {
    const scienceOnly = { ...tutor, academicGroups: ["SCIENCE" as AcademicGroup] };
    expect(matchesTutorSet({ ...request, academicGroup: "BUSINESS" }, scienceOnly)).toBe(false);
    expect(matchesTutorSet({ ...request, academicGroup: "SCIENCE" }, scienceOnly)).toBe(true);
  });

  it("matches any request group when the request has no group", () => {
    const scienceOnly = { ...tutor, academicGroups: ["SCIENCE" as AcademicGroup] };
    expect(matchesTutorSet(request, scienceOnly)).toBe(true);
  });

  it("matches when the request has no targets or the tutor has none", () => {
    const at13 = { ...request, levelCode: 13 };
    const tutorTargets = { ...tutor, levelMax: 13, admissionTargets: ["ISSB" as AdmissionTarget] };
    expect(matchesTutorSet({ ...at13, admissionTargets: [] }, tutorTargets)).toBe(true);
    expect(
      matchesTutorSet({ ...at13, admissionTargets: ["MEDICAL"] }, { ...tutor, levelMax: 13 }),
    ).toBe(true);
  });

  it("matches on overlapping targets and not otherwise", () => {
    const at13 = { ...request, levelCode: 13 };
    const tutorTargets = { ...tutor, levelMax: 13, admissionTargets: ["ISSB" as AdmissionTarget] };
    expect(matchesTutorSet({ ...at13, admissionTargets: ["MEDICAL", "ISSB"] }, tutorTargets)).toBe(
      true,
    );
    expect(matchesTutorSet({ ...at13, admissionTargets: ["MEDICAL"] }, tutorTargets)).toBe(false);
  });

  it("never matches a null level or null curriculum", () => {
    expect(matchesTutorSet({ ...request, levelCode: null }, tutor)).toBe(false);
    expect(matchesTutorSet({ ...request, curriculum: null }, tutor)).toBe(false);
  });
});

describe("educationLookup", () => {
  const body = educationLookup();

  it("has the expected top-level shape", () => {
    expect(body.version).toBe(1);
    expect(body.levelRange).toEqual({ min: -4, max: 13 });
    expect(body.groupLevels).toEqual({ min: 9, max: 12 });
    expect(body.admissionLevel).toBe(13);
    expect(body.levelNoteMaxLength).toBe(40);
    expect(body.curricula).toHaveLength(7);
    expect(body.admissionTargets).toHaveLength(10);
    expect(body.retakerLabels.map((r) => r.level)).toEqual([10, 12, 13]);
  });

  it("lists only levels inside the range, sorted ascending, with labels", () => {
    for (const curriculum of body.curricula) {
      const codes = curriculum.levels.map((l) => l.code);
      expect(codes.length).toBeGreaterThan(0);
      expect(codes).toEqual([...codes].sort((a, b) => a - b));
      for (const level of curriculum.levels) {
        expect(level.code).toBeGreaterThanOrEqual(-4);
        expect(level.code).toBeLessThanOrEqual(13);
        expect(level.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("lists each curriculum's groups from the group rules", () => {
    const groupsOf = (code: string) =>
      body.curricula.find((c) => c.code === code)?.groups.map((g) => g.code);
    expect(groupsOf("BANGLA_MEDIUM")).toEqual(["SCIENCE", "BUSINESS", "HUMANITIES"]);
    expect(groupsOf("MADRASAH")).toEqual(["SCIENCE", "HUMANITIES", "MUJABBID"]);
    expect(groupsOf("EM_IB")).toEqual([]);
  });
});

// Parity with prisma/constraints.sql. The DB does not know which levels a curriculum hides,
// so the "not offered" issue is dropped before comparing.
function dbRelevantIssues(issues: EducationIssue[]) {
  return issues.filter((i) => i.message !== NOT_OFFERED);
}

const CHECK_VIOLATION = /check constraint|violates check|P2004/i;

// Returns true when Postgres rejected the row with a CHECK violation. Any other error is a real failure.
async function insertRejectedByCheck(insert: () => Promise<unknown>): Promise<boolean> {
  try {
    await insert();
    return false;
  } catch (err) {
    const text = `${(err as Error).name} ${(err as Error).message} ${(err as { code?: string }).code ?? ""}`;
    if (CHECK_VIOLATION.test(text)) return true;
    throw err;
  }
}

describe("education rules match the database CHECK constraints", () => {
  it("tuition_requirement: TS and DB agree for every curriculum, level and group", async () => {
    const account = await createAccount();
    const area = await createArea();
    const student = await createStudentProfile(account.id, area.id);

    const mismatches: string[] = [];
    let checked = 0;
    let accepted = 0;
    let rejected = 0;

    for (const curriculum of CURRICULA) {
      for (let levelCode = -5; levelCode <= 14; levelCode++) {
        for (const academicGroup of [null, ...ACADEMIC_GROUPS] as (AcademicGroup | null)[]) {
          const input: StudentEducation = {
            curriculum,
            levelCode,
            academicGroup,
            admissionTargets: [],
            isRetaker: false,
            levelNote: null,
          };
          const tsRejected = dbRelevantIssues(validateStudentEducation(input)).length > 0;
          const dbRejected = await insertRejectedByCheck(() =>
            prisma.tuitionRequirement.create({
              data: {
                studentId: student.id,
                curriculum,
                levelCode,
                academicGroup,
                admissionTargets: [],
                isRetaker: false,
                timeOfDay: new Date("2024-01-01T10:00:00Z"),
                daysPerWeek: 3,
                salary: 5000,
                hireByDate: new Date("2024-12-31"),
                tuitionType: "Home Tutoring Solo",
              },
            }),
          );
          checked++;
          if (dbRejected) rejected++;
          else accepted++;
          if (dbRejected !== tsRejected) {
            mismatches.push(
              `${curriculum} level=${levelCode} group=${academicGroup}: db=${dbRejected ? "reject" : "accept"} ts=${tsRejected ? "reject" : "accept"}`,
            );
          }
        }
      }
    }

    expect(checked).toBe(CURRICULA.length * 20 * (ACADEMIC_GROUPS.length + 1));
    // Guard against a vacuous pass: both outcomes must occur.
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  }, 180_000);

  it("tuition_requirement: admission targets and retaker flag agree at each level", async () => {
    const account = await createAccount();
    const area = await createArea();
    const student = await createStudentProfile(account.id, area.id);

    const mismatches: string[] = [];
    const curriculum: Curriculum = "MADRASAH";
    for (let levelCode = -5; levelCode <= 14; levelCode++) {
      for (const admissionTargets of [[], ["MEDICAL"]] as AdmissionTarget[][]) {
        for (const isRetaker of [false, true]) {
          const input: StudentEducation = {
            curriculum,
            levelCode,
            academicGroup: null,
            admissionTargets,
            isRetaker,
            levelNote: null,
          };
          const tsRejected = dbRelevantIssues(validateStudentEducation(input)).length > 0;
          const dbRejected = await insertRejectedByCheck(() =>
            prisma.tuitionRequirement.create({
              data: { studentId: student.id, curriculum, levelCode, admissionTargets, isRetaker },
            }),
          );
          if (dbRejected !== tsRejected) {
            mismatches.push(
              `${curriculum} level=${levelCode} targets=${JSON.stringify(admissionTargets)} retaker=${isRetaker}: db=${dbRejected ? "reject" : "accept"} ts=${tsRejected ? "reject" : "accept"}`,
            );
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  }, 180_000);

  it("tutor_requirement: TS and DB agree on sampled coverage sets", async () => {
    const account = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(account.id);

    const levels = [-5, -4, 0, 9, 12, 13, 14];
    const curriculaSets: Curriculum[][] = [[], ["MADRASAH"], ["EM_IB"], ["BANGLA_MEDIUM"]];
    const groupSets: AcademicGroup[][] = [[], ["BUSINESS"], ["MUJABBID"], ["SCIENCE"]];
    const targetSets: AdmissionTarget[][] = [[], ["ISSB"]];

    const mismatches: string[] = [];
    let checked = 0;
    for (const levelMin of levels) {
      for (const levelMax of levels) {
        for (const curricula of curriculaSets) {
          for (const academicGroups of groupSets) {
            for (const admissionTargets of targetSets) {
              const coverage: TutorCoverage = {
                levelMin,
                levelMax,
                curricula,
                academicGroups,
                admissionTargets,
              };
              const tsRejected = validateTutorCoverage(coverage).length > 0;
              const dbRejected = await insertRejectedByCheck(() =>
                prisma.tutorRequirement.create({
                  data: {
                    tutorId: tutor.id,
                    name: "Coverage",
                    levelMin,
                    levelMax,
                    curricula,
                    academicGroups,
                    admissionTargets,
                    timeFrom: new Date("1970-01-01T10:00:00Z"),
                    timeTo: new Date("1970-01-01T12:00:00Z"),
                    availableFrom: new Date("2024-01-01"),
                    teachesOnline: true,
                  },
                }),
              );
              checked++;
              if (dbRejected !== tsRejected) {
                mismatches.push(
                  `levels=${levelMin}..${levelMax} curricula=${JSON.stringify(curricula)} groups=${JSON.stringify(academicGroups)} targets=${JSON.stringify(admissionTargets)}: db=${dbRejected ? "reject" : "accept"} ts=${tsRejected ? "reject" : "accept"}`,
                );
              }
            }
          }
        }
      }
    }

    expect(checked).toBe(levels.length * levels.length * 4 * 4 * 2);
    expect(mismatches).toEqual([]);
  }, 180_000);
});
