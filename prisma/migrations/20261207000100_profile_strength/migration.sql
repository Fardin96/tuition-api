SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Profile strength: what a profile has, one row per item with its weight (weights add up to 100 per role).
-- src/lib/profile-strength.ts turns the rows into a percent, the "complete" mark and the verified badge.
-- Read-only functions: nothing here writes or locks.

CREATE FUNCTION tutor_profile_items(p_tutor uuid)
RETURNS TABLE ("key" text, "weight" int, "done" boolean)
LANGUAGE sql STABLE AS $$
  SELECT v.key, v.weight, v.done
  FROM tutor t
  JOIN account a ON a.id = t.account_id
  CROSS JOIN LATERAL (VALUES
    ('basics', 10, btrim(t.name) <> '' AND btrim(t.address) <> ''),
    ('phone_verified', 15, t.phone_verified_at IS NOT NULL),
    ('photo', 10, a.avatar_file_id IS NOT NULL OR a.google_picture_url IS NOT NULL),
    ('institute', 10, coalesce(btrim(t.institute_name), '') <> ''),
    ('subjects', 10, EXISTS (SELECT 1 FROM tutor_subject s WHERE s.tutor_id = t.id)),
    ('location_pin', 10, EXISTS (SELECT 1 FROM tutor_location l
                                 WHERE l.tutor_id = t.id AND l.geog IS NOT NULL AND l.district_code <> '')),
    ('default_set', 10, EXISTS (
       SELECT 1 FROM tutor_requirement r
       WHERE r.tutor_id = t.id AND r.is_default AND r.is_active
         AND EXISTS (SELECT 1 FROM tutor_requirement_subject rs WHERE rs.requirement_id = r.id)
         AND (r.teaches_online OR EXISTS (SELECT 1 FROM tutor_requirement_zone z WHERE z.requirement_id = r.id)))),
    ('id_verified', 15, t.verification_status = 'APPROVED'),
    ('credential', 5, EXISTS (SELECT 1 FROM tutor_credential c WHERE c.tutor_id = t.id)),
    ('video', 5, EXISTS (SELECT 1 FROM tutor_video tv WHERE tv.tutor_id = t.id AND tv.status = 'APPROVED'))
  ) AS v(key, weight, done)
  WHERE t.id = p_tutor;
$$;

CREATE FUNCTION student_profile_items(p_student uuid)
RETURNS TABLE ("key" text, "weight" int, "done" boolean)
LANGUAGE sql STABLE AS $$
  SELECT v.key, v.weight, v.done
  FROM student s
  JOIN account a ON a.id = s.account_id
  CROSS JOIN LATERAL (VALUES
    ('basics', 15, btrim(s.name) <> '' AND btrim(s.address) <> '' AND btrim(s.emergency_contact) <> ''),
    ('phone_verified', 25, s.phone_verified_at IS NOT NULL),
    ('photo', 15, a.avatar_file_id IS NOT NULL OR a.google_picture_url IS NOT NULL),
    ('location_pin', 15, EXISTS (SELECT 1 FROM student_location l
                                 WHERE l.student_id = s.id AND l.geog IS NOT NULL AND l.district_code <> '')),
    ('id_verified', 20, s.verification_status = 'APPROVED'),
    ('whatsapp', 10, s.whatsapp_number IS NOT NULL)
  ) AS v(key, weight, done)
  WHERE s.id = p_student;
$$;
