import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { loadProfileItems, PROFILE_ITEM_KEYS } from "../../lib/profile-strength.js";
import {
  createAccount,
  createApplication,
  createArea,
  createFileAsset,
  createRequirement,
  createStudentProfile,
  createSubject,
  createTestApp,
  createTutorProfile,
  createTutorRequirement,
  createTutorZone,
  getAuthHeaders,
  setStudentLocation,
  setTutorLocation,
} from "../../tests/helpers.js";

const TUTOR_KEYS = [
  "basics",
  "phone_verified",
  "photo",
  "institute",
  "subjects",
  "location_pin",
  "default_set",
  "id_verified",
  "credential",
  "video",
];
const STUDENT_KEYS = [
  "basics",
  "phone_verified",
  "photo",
  "location_pin",
  "id_verified",
  "whatsapp",
];

// A listed tutor with the default set, location, subject and institute. Items are switched on by option.
async function listedTutor(
  options: {
    idApproved?: boolean;
    phoneVerified?: boolean;
    credential?: boolean;
    video?: boolean;
  } = {},
) {
  const { idApproved = true, phoneVerified = true, credential = false, video = false } = options;
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id, {
    instituteName: "BUET",
    isListed: true,
    verificationStatus: idApproved ? "APPROVED" : "NOT_SUBMITTED",
  });
  if (phoneVerified) {
    await prisma.tutor.update({ where: { id: tutor.id }, data: { phoneVerifiedAt: new Date() } });
  }
  await prisma.account.update({
    where: { id: account.id },
    data: { googlePictureUrl: "https://lh3.example.com/photo.jpg" },
  });
  const area = await createArea();
  await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: area.id } });
  const subject = await createSubject();
  await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: subject.id } });
  await setTutorLocation(tutor.id);
  const zoneIds = [await createTutorZone(tutor.id, { radiusM: 5000 })];
  await createTutorRequirement(tutor.id, { isDefault: true, subjectIds: [subject.id], zoneIds });
  if (credential) {
    const file = await createFileAsset(account.id, "CREDENTIAL");
    await prisma.tutorCredential.create({
      data: { tutorId: tutor.id, examLabel: "SSC", result: "A+", fileId: file.id },
    });
  }
  if (video) {
    const file = await createFileAsset(account.id, "TUTOR_VIDEO");
    await prisma.tutorVideo.create({
      data: { tutorId: tutor.id, fileId: file.id, title: "Intro", status: "APPROVED" },
    });
  }
  return { account, tutor, subject, headers: await getAuthHeaders(account) };
}

// Every student item done: basics, phone, photo, location pin, ID and WhatsApp (100).
async function verifiedStudent() {
  const area = await createArea();
  const account = await createAccount({ role: "STUDENT" });
  await prisma.account.update({
    where: { id: account.id },
    data: { googlePictureUrl: "https://lh3.example.com/photo.jpg" },
  });
  const student = await createStudentProfile(account.id, area.id, {
    whatsappNumber: `+88016${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
  });
  const idFile = await createFileAsset(account.id, "STUDENT_ID");
  await prisma.student.update({
    where: { id: student.id },
    data: {
      phoneVerifiedAt: new Date(),
      verificationStatus: "APPROVED",
      verificationFileId: idFile.id,
    },
  });
  await setStudentLocation(student.id, { districtCode: "dhaka", lat: 23.8103, lng: 90.4125 });
  return { account, student, headers: await getAuthHeaders(account) };
}

describe("profile strength", () => {
  it("a fresh tutor's percent is the sum of the items done", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "TUTOR" });
    await createTutorProfile(account.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: await getAuthHeaders(account),
    });

    expect(res.statusCode).toBe(200);
    const { profileStrength } = JSON.parse(res.body).account;
    const done = profileStrength.items.filter((i: { done: boolean }) => i.done);
    const sum = done.reduce((total: number, i: { weight: number }) => total + i.weight, 0);
    expect(profileStrength.percent).toBe(sum);
    expect(profileStrength.percent).toBe(10);
    expect(profileStrength.complete).toBe(false);
    expect(profileStrength.completeAt).toBe(60);
    expect(profileStrength.badgeAt).toBe(85);
    expect(profileStrength.verifiedBadge).toBe(false);
  });

  it("phone and ID verified with enough items gives the badge on /me, the profile and the list", async () => {
    const app = await createTestApp();
    const { account, tutor } = await listedTutor();

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: await getAuthHeaders(account),
    });
    expect(JSON.parse(me.body).account.profileStrength).toMatchObject({
      percent: 90,
      complete: true,
      verifiedBadge: true,
    });

    const profile = await app.inject({ method: "GET", url: `/api/v1/tutors/${tutor.id}` });
    expect(JSON.parse(profile.body).tutor.verifiedBadge).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/v1/tutors" });
    const row = JSON.parse(list.body).tutors.find((t: { id: string }) => t.id === tutor.id);
    expect(row.verifiedBadge).toBe(true);
  });

  it("a tutor without ID approval has no badge, even at a high percent", async () => {
    const app = await createTestApp();
    const { account, tutor } = await listedTutor({
      idApproved: false,
      credential: true,
      video: true,
    });

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: await getAuthHeaders(account),
    });
    expect(JSON.parse(me.body).account.profileStrength).toMatchObject({
      percent: 85,
      verifiedBadge: false,
    });

    const profile = await app.inject({ method: "GET", url: `/api/v1/tutors/${tutor.id}` });
    expect(JSON.parse(profile.body).tutor.verifiedBadge).toBe(false);

    const list = await app.inject({ method: "GET", url: "/api/v1/tutors" });
    const row = JSON.parse(list.body).tutors.find((t: { id: string }) => t.id === tutor.id);
    expect(row.verifiedBadge).toBe(false);
  });

  it("a student gets profileStrength with the student keys", async () => {
    const app = await createTestApp();
    const area = await createArea();
    const account = await createAccount({ role: "STUDENT" });
    await createStudentProfile(account.id, area.id, { whatsappNumber: "+8801711111111" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: await getAuthHeaders(account),
    });

    const { profileStrength } = JSON.parse(res.body).account;
    expect(profileStrength.items.map((i: { key: string }) => i.key)).toEqual(STUDENT_KEYS);
    // basics 15 and whatsapp 10 are done.
    expect(profileStrength.percent).toBe(25);
    expect(profileStrength.completeAt).toBe(60);
    expect(profileStrength.badgeAt).toBe(80);
  });

  it("a fully verified student reaches the badge on /me", async () => {
    const app = await createTestApp();
    const { headers } = await verifiedStudent();

    const res = await app.inject({ method: "GET", url: "/api/v1/me", headers });

    expect(JSON.parse(res.body).account.profileStrength).toMatchObject({
      percent: 100,
      verifiedBadge: true,
    });
  });

  it("the SQL items sum to 100 for each role and come back in the documented order", async () => {
    const tutorAccount = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(tutorAccount.id);
    const tutorItems = await loadProfileItems(prisma, "TUTOR", tutor.id);
    expect(tutorItems.map((i) => i.key)).toEqual(TUTOR_KEYS);
    expect(tutorItems.reduce((sum, i) => sum + i.weight, 0)).toBe(100);

    const studentAccount = await createAccount({ role: "STUDENT" });
    const student = await createStudentProfile(studentAccount.id, (await createArea()).id);
    const studentItems = await loadProfileItems(prisma, "STUDENT", student.id);
    expect(studentItems.map((i) => i.key)).toEqual(STUDENT_KEYS);
    expect(studentItems.reduce((sum, i) => sum + i.weight, 0)).toBe(100);

    // The client-facing key list covers every key the SQL can return.
    expect(
      [...TUTOR_KEYS, ...STUDENT_KEYS].every((k) => PROFILE_ITEM_KEYS.includes(k as never)),
    ).toBe(true);
  });

  it("GET /tutors/nearby gives a fully verified tutor the badge", async () => {
    const app = await createTestApp();
    const { tutor } = await listedTutor();
    const { headers } = await verifiedStudent();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tutors/nearby?radiusMeters=2000",
      headers,
    });

    const card = JSON.parse(res.body).tutors.find((t: { id: string }) => t.id === tutor.id);
    expect(card.verifiedBadge).toBe(true);
  });

  it("the application detail, the applicant list and the recommended tutors carry the tutor badge", async () => {
    const app = await createTestApp();
    const tutor = await listedTutor();
    const student = await verifiedStudent();
    const requirement = await createRequirement({
      studentId: student.student.id,
      subjectIds: [tutor.subject.id],
    });
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.tutor.id,
      studentId: student.student.id,
      initiatedBy: "TUTOR",
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/applications/${application.id}`,
      headers: student.headers,
    });
    const body = JSON.parse(detail.body);
    expect(body.tutor.verifiedBadge).toBe(true);
    expect(body.tutorProfile.verifiedBadge).toBe(true);
    expect(body.student.verifiedBadge).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${requirement.id}/applications`,
      headers: student.headers,
    });
    expect(JSON.parse(list.body).applications[0].tutor.verifiedBadge).toBe(true);

    const recommended = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${requirement.id}/tutors`,
      headers: student.headers,
    });
    const row = JSON.parse(recommended.body).tutors.find(
      (r: { tutor: { id: string } }) => r.tutor.id === tutor.tutor.id,
    );
    expect(row.tutor.verifiedBadge).toBe(true);
  });

  it("a tutor viewing an application sees the student's badge", async () => {
    const app = await createTestApp();
    const tutor = await listedTutor();
    const student = await verifiedStudent();
    const requirement = await createRequirement({
      studentId: student.student.id,
      subjectIds: [tutor.subject.id],
    });
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.tutor.id,
      studentId: student.student.id,
      initiatedBy: "STUDENT",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/applications/${application.id}`,
      headers: tutor.headers,
    });

    expect(JSON.parse(res.body).student.verifiedBadge).toBe(true);
  });
});
