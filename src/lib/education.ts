// Single source of truth for education levels. GET /lookups/education serves these labels; the
// frontend never hardcodes them. prisma/constraints.sql enforces the same rules (see education.test.ts).

export const LEVEL_MIN = -4;
export const LEVEL_MAX = 13;
export const ADMISSION_LEVEL = 13;
export const GROUP_LEVEL_MIN = 9;
export const GROUP_LEVEL_MAX = 12;
export const RETAKER_LEVELS = [10, 12, 13] as const;
export const LEVEL_NOTE_MAX = 40;

export const CURRICULA = [
  "BANGLA_MEDIUM",
  "ENGLISH_VERSION",
  "EM_CAMBRIDGE",
  "EM_EDEXCEL",
  "EM_IB",
  "EM_AMERICAN",
  "MADRASAH",
] as const;
export type Curriculum = (typeof CURRICULA)[number];

export const ACADEMIC_GROUPS = ["SCIENCE", "BUSINESS", "HUMANITIES", "MUJABBID"] as const;
export type AcademicGroup = (typeof ACADEMIC_GROUPS)[number];

export const ADMISSION_TARGETS = [
  "ENGINEERING",
  "MEDICAL",
  "VARSITY_SCIENCE",
  "VARSITY_HUMANITIES",
  "VARSITY_BUSINESS",
  "AGRICULTURE",
  "IBA_BUP",
  "PRIVATE_UNI",
  "ABROAD_TESTS",
  "ISSB",
] as const;
export type AdmissionTarget = (typeof ADMISSION_TARGETS)[number];

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const ADMISSION_LABEL = "Admission & test prep";

function britishLevels(o: [string, string, string, string]): Record<number, string> {
  return {
    [-4]: "Toddler",
    [-3]: "Playgroup",
    [-2]: "Nursery",
    [-1]: "KG 1 (Reception)",
    0: "KG 2 (Year 1)",
    ...Object.fromEntries(range(1, 8).map((n) => [n, `Grade ${n} (Year ${n + 1})`])),
    9: o[0],
    10: o[1],
    11: o[2],
    12: o[3],
    13: ADMISSION_LABEL,
  };
}

const NCTB_LEVELS: Record<number, string> = {
  [-2]: "Playgroup",
  [-1]: "Nursery",
  0: "KG",
  ...Object.fromEntries(range(1, 9).map((n) => [n, `Class ${n}`])),
  10: "Class 10 (SSC)",
  11: "HSC 1st year",
  12: "HSC 2nd year",
  13: ADMISSION_LABEL,
};

const NCTB_GROUPS = { SCIENCE: "Science", BUSINESS: "Business Studies", HUMANITIES: "Humanities" };

interface CurriculumInfo {
  label: string;
  // A level missing here is hidden for this curriculum.
  levels: Record<number, string>;
  groups: Partial<Record<AcademicGroup, string>>;
}

export const CURRICULUM_INFO: Record<Curriculum, CurriculumInfo> = {
  BANGLA_MEDIUM: { label: "Bangla Medium", levels: NCTB_LEVELS, groups: NCTB_GROUPS },
  ENGLISH_VERSION: { label: "English Version", levels: NCTB_LEVELS, groups: NCTB_GROUPS },
  EM_CAMBRIDGE: {
    label: "English Medium (Cambridge)",
    levels: britishLevels([
      "Grade 9 (Year 10, O Level)",
      "Grade 10 (Year 11, O Level)",
      "Grade 11 (Year 12, AS Level)",
      "Grade 12 (Year 13, A2 Level)",
    ]),
    groups: {},
  },
  EM_EDEXCEL: {
    label: "English Medium (Edexcel)",
    levels: britishLevels([
      "Grade 9 (Year 10, IGCSE)",
      "Grade 10 (Year 11, IGCSE)",
      "Grade 11 (Year 12, IAS)",
      "Grade 12 (Year 13, IAL)",
    ]),
    groups: {},
  },
  EM_IB: {
    label: "IB",
    levels: {
      [-2]: "Early Years 1",
      [-1]: "Early Years 2",
      ...Object.fromEntries(range(1, 5).map((n) => [n, `PYP Grade ${n}`])),
      ...Object.fromEntries(range(6, 10).map((n) => [n, `MYP Year ${n - 5}`])),
      11: "DP Year 1",
      12: "DP Year 2",
      13: ADMISSION_LABEL,
    },
    groups: {},
  },
  EM_AMERICAN: {
    label: "American",
    levels: {
      [-2]: "Pre-K 3",
      [-1]: "Pre-K 4",
      ...Object.fromEntries(range(1, 12).map((n) => [n, `Grade ${n}`])),
      13: ADMISSION_LABEL,
    },
    groups: {},
  },
  MADRASAH: {
    label: "Madrasah (Alia)",
    levels: {
      [-1]: "Shishu",
      0: "Shishu",
      ...Object.fromEntries(range(1, 5).map((n) => [n, `Ebtedayee ${n}`])),
      ...Object.fromEntries(range(6, 10).map((n) => [n, `Dakhil ${n}`])),
      11: "Alim 1st year",
      12: "Alim 2nd year",
      13: ADMISSION_LABEL,
    },
    // HUMANITIES is the Madrasah "General" group.
    groups: { SCIENCE: "Science", HUMANITIES: "General", MUJABBID: "Mujabbid" },
  },
};

export const RETAKER_LABELS: Record<(typeof RETAKER_LEVELS)[number], string> = {
  10: "Retake / improvement",
  12: "Retake / improvement",
  13: "2nd timer",
};

export const ADMISSION_TARGET_INFO: Record<AdmissionTarget, { label: string; covers: string }> = {
  ENGINEERING: { label: "Engineering", covers: "BUET, CKRUET, IUT, MIST, BUTEX" },
  MEDICAL: { label: "Medical", covers: "MBBS/BDS, AFMC" },
  VARSITY_SCIENCE: { label: "University: Science", covers: "DU Ka, JU, RU, CU, GST science" },
  VARSITY_HUMANITIES: { label: "University: Humanities", covers: "Kha units" },
  VARSITY_BUSINESS: { label: "University: Business", covers: "Ga units" },
  AGRICULTURE: { label: "Agriculture", covers: "Agri cluster" },
  IBA_BUP: { label: "IBA / BUP", covers: "DU/JU IBA, BUP" },
  PRIVATE_UNI: { label: "Private universities", covers: "NSU, BRACU, IUB, AIUB, EWU, AUST" },
  ABROAD_TESTS: { label: "Study abroad tests", covers: "SAT, IELTS, TOEFL, Duolingo, GED" },
  ISSB: { label: "ISSB / defence", covers: "Military and defence academies" },
};

export function levelLabel(curriculum: Curriculum, level: number): string | undefined {
  return CURRICULUM_INFO[curriculum].levels[level];
}

export function groupAllowed(curriculum: Curriculum, group: AcademicGroup): boolean {
  return group in CURRICULUM_INFO[curriculum].groups;
}

const isRetakerLevel = (level: number) => (RETAKER_LEVELS as readonly number[]).includes(level);
const inGroupRange = (level: number) => level >= GROUP_LEVEL_MIN && level <= GROUP_LEVEL_MAX;

/** Trims, collapses whitespace and strips control characters; empty becomes null. */
export function normalizeLevelNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const clean = note
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean === "" ? null : clean;
}

export interface StudentEducation {
  curriculum: Curriculum | null;
  levelCode: number | null;
  academicGroup: AcademicGroup | null;
  admissionTargets: AdmissionTarget[];
  isRetaker: boolean;
  levelNote: string | null;
}

export interface EducationIssue {
  path: string;
  message: string;
}

/**
 * Checks one student's education fields. Drafts may leave curriculum and level empty;
 * extras still have to fit whatever is set.
 */
export function validateStudentEducation(e: StudentEducation): EducationIssue[] {
  const issues: EducationIssue[] = [];
  const { curriculum, levelCode } = e;

  if (levelCode !== null && (levelCode < LEVEL_MIN || levelCode > LEVEL_MAX)) {
    issues.push({
      path: "levelCode",
      message: `Level must be between ${LEVEL_MIN} and ${LEVEL_MAX}`,
    });
    return issues;
  }
  if (
    curriculum !== null &&
    levelCode !== null &&
    levelLabel(curriculum, levelCode) === undefined
  ) {
    issues.push({ path: "levelCode", message: "This level is not offered for this curriculum" });
  }
  if (e.academicGroup !== null) {
    if (curriculum === null || levelCode === null || !inGroupRange(levelCode)) {
      issues.push({ path: "academicGroup", message: "A group only applies to levels 9 to 12" });
    } else if (!groupAllowed(curriculum, e.academicGroup)) {
      issues.push({
        path: "academicGroup",
        message: "This group is not offered for this curriculum",
      });
    }
  }
  if (e.admissionTargets.length > 0 && levelCode !== ADMISSION_LEVEL) {
    issues.push({ path: "admissionTargets", message: "Admission targets only apply to level 13" });
  }
  if (new Set(e.admissionTargets).size !== e.admissionTargets.length) {
    issues.push({ path: "admissionTargets", message: "Admission targets must be unique" });
  }
  if (e.isRetaker && (levelCode === null || !isRetakerLevel(levelCode))) {
    issues.push({ path: "isRetaker", message: "Retaking only applies to levels 10, 12 and 13" });
  }
  if (e.levelNote !== null && e.levelNote.length > LEVEL_NOTE_MAX) {
    issues.push({
      path: "levelNote",
      message: `Keep the note under ${LEVEL_NOTE_MAX + 1} characters`,
    });
  }
  return issues;
}

export interface TutorCoverage {
  levelMin: number;
  levelMax: number;
  curricula: Curriculum[];
  academicGroups: AcademicGroup[];
  admissionTargets: AdmissionTarget[];
}

export function validateTutorCoverage(c: TutorCoverage): EducationIssue[] {
  const issues: EducationIssue[] = [];
  if (c.levelMin < LEVEL_MIN || c.levelMax > LEVEL_MAX || c.levelMax < c.levelMin) {
    issues.push({
      path: "levelMax",
      message: `Levels must run from low to high within ${LEVEL_MIN} to ${LEVEL_MAX}`,
    });
  }
  if (c.curricula.length === 0) {
    issues.push({ path: "curricula", message: "Pick at least one curriculum" });
  }
  for (const [path, list] of [
    ["curricula", c.curricula],
    ["academicGroups", c.academicGroups],
    ["admissionTargets", c.admissionTargets],
  ] as const) {
    if (new Set(list).size !== list.length) issues.push({ path, message: "Values must be unique" });
  }
  if (c.academicGroups.length > 0) {
    if (c.levelMin > GROUP_LEVEL_MAX || c.levelMax < GROUP_LEVEL_MIN) {
      issues.push({
        path: "academicGroups",
        message: "Groups only apply when the range covers levels 9 to 12",
      });
    } else if (!c.academicGroups.every((g) => c.curricula.some((cur) => groupAllowed(cur, g)))) {
      issues.push({
        path: "academicGroups",
        message: "Each group must belong to a chosen curriculum",
      });
    }
  }
  if (c.admissionTargets.length > 0 && c.levelMax !== ADMISSION_LEVEL) {
    issues.push({
      path: "admissionTargets",
      message: "Admission targets need the range to reach level 13",
    });
  }
  return issues;
}

/**
 * Whether a tutor set covers a requirement. Empty tutor groups or targets mean "any";
 * isRetaker and levelNote never affect matching.
 */
export function matchesTutorSet(
  r: Pick<StudentEducation, "curriculum" | "levelCode" | "academicGroup" | "admissionTargets">,
  t: TutorCoverage,
): boolean {
  if (r.curriculum === null || r.levelCode === null) return false;
  if (!t.curricula.includes(r.curriculum)) return false;
  if (r.levelCode < t.levelMin || r.levelCode > t.levelMax) return false;
  if (r.academicGroup && t.academicGroups.length > 0 && !t.academicGroups.includes(r.academicGroup))
    return false;
  if (
    r.admissionTargets.length > 0 &&
    t.admissionTargets.length > 0 &&
    !r.admissionTargets.some((a) => t.admissionTargets.includes(a))
  )
    return false;
  return true;
}

/** The body of GET /lookups/education. Bump `version` when labels or rules change. */
export function educationLookup() {
  return {
    version: 1,
    levelRange: { min: LEVEL_MIN, max: LEVEL_MAX },
    groupLevels: { min: GROUP_LEVEL_MIN, max: GROUP_LEVEL_MAX },
    admissionLevel: ADMISSION_LEVEL,
    levelNoteMaxLength: LEVEL_NOTE_MAX,
    curricula: CURRICULA.map((code) => ({
      code,
      label: CURRICULUM_INFO[code].label,
      levels: Object.entries(CURRICULUM_INFO[code].levels)
        .map(([level, label]) => ({ code: Number(level), label }))
        .sort((a, b) => a.code - b.code),
      groups: ACADEMIC_GROUPS.filter((g) => groupAllowed(code, g)).map((g) => ({
        code: g,
        label: CURRICULUM_INFO[code].groups[g] as string,
      })),
    })),
    admissionTargets: ADMISSION_TARGETS.map((code) => ({ code, ...ADMISSION_TARGET_INFO[code] })),
    retakerLabels: RETAKER_LEVELS.map((level) => ({ level, label: RETAKER_LABELS[level] })),
  };
}
