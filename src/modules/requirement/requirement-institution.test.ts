import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createArea,
  createStudentProfile,
  createSubject,
  createTestApp,
  getAuthHeaders,
} from "../../tests/helpers.js";

const URL = "/api/v1/requirements/";

// Drafts skip the phone and duplicate gates, so these cases only test the institute rule.
async function setup() {
  const app = await createTestApp();
  const account = await createAccount({ role: "STUDENT" });
  const area = await createArea();
  const subject = await createSubject();
  await createStudentProfile(account.id, area.id);
  const headers = await getAuthHeaders(account);
  const draft = (extra: Record<string, unknown> = {}) => ({
    status: "DRAFT",
    areaId: area.id,
    subjectIds: [subject.id],
    curriculum: "BANGLA_MEDIUM",
    levelCode: 10,
    ...extra,
  });
  return { app, headers, draft };
}

describe("requirement institution pick (institutionId)", () => {
  it("stores the canonical name of a picked institution", async () => {
    const { app, headers, draft } = await setup();

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers,
      payload: draft({ instituteName: "Dhaka Uni", institutionId: 1 }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      institutionId: 1,
      instituteName: "University of Dhaka",
    });
  });

  it("keeps typed text unlinked", async () => {
    const { app, headers, draft } = await setup();

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers,
      payload: draft({ instituteName: "Local School" }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ institutionId: null, instituteName: "Local School" });
  });

  it("answers 400 on institutionId for an unknown id", async () => {
    const { app, headers, draft } = await setup();

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers,
      payload: draft({ institutionId: 999999 }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().issues).toEqual([
      { path: ["institutionId"], message: "Pick a school or university from the list." },
    ]);
  });

  it("answers 400 on institutionId for an inactive institution", async () => {
    const { app, headers, draft } = await setup();
    const inactive = await prisma.institution.create({
      data: { name: `Closed ${crypto.randomUUID()}`, kind: "SCHOOL", isActive: false },
    });

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers,
      payload: draft({ institutionId: inactive.id }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toEqual(["institutionId"]);
  });

  it("PATCH relinks to the canonical name, text-only unlinks, null unlinks", async () => {
    const { app, headers, draft } = await setup();
    const created = (
      await app.inject({
        method: "POST",
        url: URL,
        headers,
        payload: draft({ institutionId: 1 }),
      })
    ).json();
    const patch = (payload: object) =>
      app.inject({ method: "PATCH", url: `${URL}${created.id}`, headers, payload });

    const relinked = await patch({ institutionId: 79, instituteName: "bracu" });
    expect(relinked.json()).toMatchObject({ institutionId: 79, instituteName: "BRAC University" });

    const textOnly = await patch({ instituteName: "Free text" });
    expect(textOnly.json()).toMatchObject({ institutionId: null, instituteName: "Free text" });

    await patch({ institutionId: 1 });
    const cleared = await patch({ institutionId: null });
    expect(cleared.json()).toMatchObject({
      institutionId: null,
      instituteName: "University of Dhaka",
    });
  });

  it("the web's shape, institutionId null with exact typed text, links the institution", async () => {
    const { app, headers, draft } = await setup();
    const created = (
      await app.inject({
        method: "POST",
        url: URL,
        headers,
        payload: draft({ instituteName: "Old text" }),
      })
    ).json();

    const res = await app.inject({
      method: "PATCH",
      url: `${URL}${created.id}`,
      headers,
      payload: { institutionId: null, instituteName: "BRAC University" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ institutionId: 79, instituteName: "BRAC University" });
  });

  it("the web's hidden-link shape, same institutionId with its name, still saves", async () => {
    const { app, headers, draft } = await setup();
    const hidden = await prisma.institution.create({
      data: { name: `Hidden ${crypto.randomUUID()}`, kind: "COLLEGE", isActive: false },
    });
    const created = (
      await app.inject({ method: "POST", url: URL, headers, payload: draft() })
    ).json();
    await prisma.tuitionRequirement.update({
      where: { id: created.id },
      data: { institutionId: hidden.id, instituteName: hidden.name },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `${URL}${created.id}`,
      headers,
      payload: { institutionId: hidden.id, instituteName: hidden.name, salary: 7000 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      institutionId: hidden.id,
      instituteName: hidden.name,
      salary: 7000,
    });
  });

  it("links typed text that exactly names one active institution", async () => {
    const { app, headers, draft } = await setup();

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers,
      payload: draft({ instituteName: "University of Dhaka" }),
    });

    expect(res.json()).toMatchObject({ institutionId: 1, instituteName: "University of Dhaka" });
  });

  it("keeps the link to a since-hidden institution when the same id is sent again", async () => {
    const { app, headers, draft } = await setup();
    const hidden = await prisma.institution.create({
      data: { name: `Hidden ${crypto.randomUUID()}`, kind: "COLLEGE", isActive: false },
    });
    const created = (
      await app.inject({ method: "POST", url: URL, headers, payload: draft() })
    ).json();
    await prisma.tuitionRequirement.update({
      where: { id: created.id },
      data: { institutionId: hidden.id, instituteName: hidden.name },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `${URL}${created.id}`,
      headers,
      payload: { institutionId: hidden.id, salary: 6000 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      institutionId: hidden.id,
      instituteName: hidden.name,
      salary: 6000,
    });
  });

  it("null institutionId with null text clears the text", async () => {
    const { app, headers, draft } = await setup();
    const created = (
      await app.inject({
        method: "POST",
        url: URL,
        headers,
        payload: draft({ instituteName: "Local School" }),
      })
    ).json();

    const res = await app.inject({
      method: "PATCH",
      url: `${URL}${created.id}`,
      headers,
      payload: { institutionId: null, instituteName: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ institutionId: null, instituteName: null });
  });
});
