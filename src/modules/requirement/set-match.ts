import { Prisma } from "../../generated/prisma/client.js";

// Filter, not the matching algorithm: whether a tutor set covers a requirement.
// Four rules, all must hold:
//   1. Curriculum: the requirement's curriculum is one of the set's curricula.
//   2. Level: the requirement's level is inside the set's level band.
//   3. Subject: at least one requirement subject is also a subject of the set.
//   4. Area: when the set has zones, the student pin is inside one of THE SET's zones.
//      When it has none, the same nearby rule as the browse: the pin is inside one of the
//      tutor's zones, or the requirement's area is one of the tutor's areas.
// Aliases: tr = tutor_requirement, r = tuition_requirement, sl = student_location of r's student.
// The fragment has no leading AND and is parenthesised, so callers can drop it into any WHERE.
export function setMatchesRequirementSql(): Prisma.Sql {
  return Prisma.sql`(
    r.curriculum = ANY(tr.curricula)
    AND r.level_code BETWEEN tr.level_min AND tr.level_max
    AND EXISTS (
      SELECT 1 FROM requirement_subject rs
      JOIN tutor_requirement_subject trs ON trs.subject_id = rs.subject_id
      WHERE rs.requirement_id = r.id AND trs.requirement_id = tr.id
    )
    AND (
      EXISTS (
        SELECT 1 FROM tutor_requirement_zone trz
        JOIN tutor_zone z ON z.id = trz.zone_id
        WHERE trz.requirement_id = tr.id
          AND sl.geog IS NOT NULL AND NOT sl.needs_readdress
          AND ST_DWithin(sl.geog, z.center, z.radius_m)
      )
      OR (
        NOT EXISTS (SELECT 1 FROM tutor_requirement_zone trz WHERE trz.requirement_id = tr.id)
        AND (
          (sl.geog IS NOT NULL AND NOT sl.needs_readdress AND EXISTS (
            SELECT 1 FROM tutor_zone z
            WHERE z.tutor_id = tr.tutor_id
              AND ST_DWithin(sl.geog, z.center, z.radius_m)))
          OR r.area_id IN (SELECT ta.area_id FROM tutor_area ta WHERE ta.tutor_id = tr.tutor_id)
        )
      )
    )
  )`;
}
