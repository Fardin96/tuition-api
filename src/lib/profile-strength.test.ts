import { describe, expect, it } from "vitest";
import { type ProfileItem, summarizeStrength } from "./profile-strength.js";

const item = (key: string, weight: number, done: boolean): ProfileItem => ({ key, weight, done });

// Tutor weights from the SQL function, summing to 100.
const TUTOR_ALL = [
  item("basics", 10, true),
  item("phone_verified", 15, true),
  item("photo", 10, true),
  item("institute", 10, true),
  item("subjects", 10, true),
  item("location_pin", 10, true),
  item("default_set", 10, true),
  item("id_verified", 15, true),
  item("credential", 5, true),
  item("video", 5, true),
];

describe("summarizeStrength", () => {
  it("sums the done weights", () => {
    const items = TUTOR_ALL.map((i) => ({ ...i, done: i.key === "basics" || i.key === "photo" }));
    expect(summarizeStrength("TUTOR", items).percent).toBe(20);
  });

  it("marks complete at 60 for a tutor and not at 59", () => {
    const at = (percent: number) =>
      summarizeStrength("TUTOR", [item("basics", percent, true), item("x", 100 - percent, false)]);
    expect(at(59).complete).toBe(false);
    expect(at(60).complete).toBe(true);
    expect(at(60).completeAt).toBe(60);
  });

  it("needs both id and phone for the badge, even at 100", () => {
    const noId = TUTOR_ALL.map((i) => (i.key === "id_verified" ? { ...i, done: false } : i));
    const noPhone = TUTOR_ALL.map((i) => (i.key === "phone_verified" ? { ...i, done: false } : i));
    expect(summarizeStrength("TUTOR", TUTOR_ALL)).toMatchObject({
      percent: 100,
      verifiedBadge: true,
    });
    expect(summarizeStrength("TUTOR", noId)).toMatchObject({ percent: 85, verifiedBadge: false });
    expect(summarizeStrength("TUTOR", noPhone)).toMatchObject({
      percent: 85,
      verifiedBadge: false,
    });
  });

  it("uses 85 for a tutor badge and 80 for a student", () => {
    const tutor84 = [
      item("id_verified", 15, true),
      item("phone_verified", 15, true),
      item("x", 54, true),
      item("y", 16, false),
    ];
    expect(summarizeStrength("TUTOR", tutor84)).toMatchObject({
      percent: 84,
      verifiedBadge: false,
      badgeAt: 85,
    });

    const student = [
      item("id_verified", 20, true),
      item("phone_verified", 25, true),
      item("basics", 15, true),
      item("photo", 15, true),
      item("location_pin", 5, true),
      item("whatsapp", 10, false),
    ];
    expect(summarizeStrength("STUDENT", student)).toMatchObject({
      percent: 80,
      verifiedBadge: true,
      badgeAt: 80,
    });
    expect(
      summarizeStrength(
        "STUDENT",
        student.map((i) => (i.key === "location_pin" ? { ...i, done: false } : i)),
      ),
    ).toMatchObject({
      percent: 75,
      verifiedBadge: false,
    });
  });

  it("returns the items it was given and zero for no items", () => {
    const empty = summarizeStrength("STUDENT", []);
    expect(empty).toMatchObject({ percent: 0, complete: false, verifiedBadge: false, items: [] });
  });
});
