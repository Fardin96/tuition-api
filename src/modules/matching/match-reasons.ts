import type { PairRow } from "./match-sql.js";
import type { MatchingConfig } from "./matching-config.js";

// Short labels for match cards. `ok` false marks a ranking rule the pair misses (shown muted).
// Labels never quote the other side's limits (a tutor's minimum salary, a student's offer).
export type MatchReason = { rule: string; ok: boolean; label: string };

const MAX_REASONS = 4;

export function reasonsFor(
  row: PairRow,
  cfg: MatchingConfig,
  viewer: "TUTOR" | "STUDENT",
): MatchReason[] {
  const you = viewer === "TUTOR";
  const hits: MatchReason[] = [];
  const misses: MatchReason[] = [];

  if (row.isOnline) hits.push({ rule: "location", ok: true, label: "Online" });
  else if (row.inZone)
    hits.push({
      rule: "location",
      ok: true,
      label: you ? "Inside your zone" : "Teaches in your area",
    });
  else if (row.distanceKm !== null)
    hits.push({ rule: "location", ok: true, label: `${formatKm(row.distanceKm)} away` });

  if (row.totalSubjects > 0 && row.sharedSubjects === 0) {
    misses.push({ rule: "subject", ok: false, label: "No shared subject" });
  } else if (row.totalSubjects > 0) {
    hits.push({
      rule: "subject",
      ok: true,
      label:
        row.sharedSubjects === row.totalSubjects
          ? row.totalSubjects === 1
            ? "Teaches the subject"
            : `All ${row.totalSubjects} subjects`
          : `${row.sharedSubjects} of ${row.totalSubjects} subjects`,
    });
  }

  if (row.pass_level) {
    if (Number(row.part_level) >= 1)
      hits.push({
        rule: "level",
        ok: true,
        label: you ? "In your class range" : "Teaches this class",
      });
    else
      hits.push({
        rule: "level",
        ok: true,
        label: you ? "Just outside your class range" : "Usually teaches a nearby class",
      });
  }

  const missLabel = (rule: "salary" | "schedule" | "capacity" | "gender"): string => {
    switch (rule) {
      case "salary":
        return you ? "Below your minimum salary" : "Salary may be below what this tutor asks";
      case "schedule":
        return you ? "Different days or time" : "Different days or time from this tutor";
      case "capacity":
        return you
          ? "More students or an earlier start than you set"
          : "May not have room or start in time";
      case "gender":
        return you ? "Prefers a different tutor gender" : "Not the tutor gender you asked for";
    }
  };
  for (const rule of ["salary", "schedule", "capacity", "gender"] as const) {
    if (cfg.rules[rule].mode === "RANK" && !row[`pass_${rule}`]) {
      misses.push({ rule, ok: false, label: missLabel(rule) });
    }
  }

  return [...hits, ...misses].slice(0, MAX_REASONS);
}

function formatKm(km: number): string {
  return km < 1 ? "Under 1 km" : `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
}
