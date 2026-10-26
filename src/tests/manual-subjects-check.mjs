import { PrismaClient } from "../generated/prisma/client.ts";
const prisma = new PrismaClient();

const area = await prisma.area.findFirst();
const category = await prisma.category.findFirst();
const subjects = await prisma.subject.findMany({ take: 2 });
console.log("area", area?.id, "category", category?.id, "subjects", subjects.map(s=>s.id));

const account = await prisma.account.create({
  data: { role: "STUDENT", googleSub: "test-sub-" + Date.now(), email: `test${Date.now()}@test.com`, consentVersion: "v1", consentAcceptedAt: new Date() },
});
const student = await prisma.student.create({
  data: { id: account.id, accountId: account.id, name: "Test", address: "Addr", emergencyContact: "123", whatsappNumber: "+8801234567890", studentIdNumber: "SID1", areaId: area.id },
});

const created = await prisma.tuitionRequirement.create({
  data: {
    studentId: student.id,
    status: "DRAFT",
    subjects: {
      createMany: {
        data: subjects.map(s => ({ subjectId: s.id })),
      },
    },
  },
  include: { subjects: true },
});
console.log("created.subjects:", created.subjects);

const fetched = await prisma.tuitionRequirement.findUnique({
  where: { id: created.id },
  include: { subjects: true },
});
console.log("fetched.subjects:", fetched.subjects);

await prisma.$disconnect();
