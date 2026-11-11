SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- /disputes/mine filters on raised_by and sorts by created_at. Plain (not CONCURRENTLY): the migration runs as one script.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX dispute_raised_by_idx ON dispute (raised_by, created_at DESC);

-- Lock the parent row before the subqueries run, so concurrent reviews for the same
-- tutor or student serialise and the last writer computes from every committed row.
-- FOR NO KEY UPDATE, not FOR UPDATE: FOR UPDATE deadlocks with the FK KEY SHARE locks of concurrent inserts.
CREATE OR REPLACE FUNCTION review_recompute() RETURNS trigger AS $$
DECLARE r review%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF r.direction = 'STUDENT_TO_TUTOR' THEN
    PERFORM 1 FROM tutor WHERE id = r.tutor_id FOR NO KEY UPDATE;
    UPDATE tutor SET
      rating_count = (SELECT count(*) FROM review WHERE tutor_id = r.tutor_id AND direction = 'STUDENT_TO_TUTOR' AND status = 'VISIBLE'),
      rating_avg   = COALESCE((SELECT round(avg(rating), 2) FROM review WHERE tutor_id = r.tutor_id AND direction = 'STUDENT_TO_TUTOR' AND status = 'VISIBLE'), 0)
    WHERE id = r.tutor_id;
  ELSE
    PERFORM 1 FROM student WHERE id = r.student_id FOR NO KEY UPDATE;
    UPDATE student SET
      rating_count = (SELECT count(*) FROM review WHERE student_id = r.student_id AND direction = 'TUTOR_TO_STUDENT' AND status = 'VISIBLE'),
      rating_avg   = COALESCE((SELECT round(avg(rating), 2) FROM review WHERE student_id = r.student_id AND direction = 'TUTOR_TO_STUDENT' AND status = 'VISIBLE'), 0)
    WHERE id = r.student_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
