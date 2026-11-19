SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Default areas and subjects, with the ids the web used before the lists moved into the database.
-- Admins edit or deactivate them later; ON CONFLICT DO NOTHING leaves anything already there alone.
INSERT INTO "area" ("id", "division", "district", "name") VALUES
  (1, 'Dhaka', 'Dhaka', 'Dhanmondi'),
  (2, 'Dhaka', 'Dhaka', 'Gulshan'),
  (3, 'Dhaka', 'Dhaka', 'Banani'),
  (4, 'Dhaka', 'Dhaka', 'Uttara'),
  (5, 'Dhaka', 'Dhaka', 'Mirpur'),
  (6, 'Dhaka', 'Dhaka', 'Mohammadpur'),
  (7, 'Dhaka', 'Dhaka', 'Bashundhara'),
  (8, 'Dhaka', 'Dhaka', 'Badda'),
  (9, 'Dhaka', 'Dhaka', 'Rampura'),
  (10, 'Dhaka', 'Dhaka', 'Khilgaon'),
  (11, 'Dhaka', 'Dhaka', 'Motijheel'),
  (12, 'Dhaka', 'Dhaka', 'Old Dhaka'),
  (13, 'Dhaka', 'Dhaka', 'Lalmatia'),
  (14, 'Dhaka', 'Dhaka', 'Tejgaon'),
  (15, 'Dhaka', 'Dhaka', 'Farmgate'),
  (16, 'Dhaka', 'Dhaka', 'Shyamoli'),
  (17, 'Dhaka', 'Dhaka', 'Malibagh'),
  (18, 'Dhaka', 'Dhaka', 'Moghbazar'),
  (19, 'Dhaka', 'Dhaka', 'Wari'),
  (20, 'Dhaka', 'Dhaka', 'Jatrabari')
ON CONFLICT DO NOTHING;

INSERT INTO "subject" ("id", "name", "slug", "sort_order") VALUES
  (1, 'Bangla', 'bangla', 0),
  (2, 'English', 'english', 1),
  (3, 'Mathematics', 'mathematics', 2),
  (4, 'Higher Mathematics', 'higher-mathematics', 3),
  (5, 'Physics', 'physics', 4),
  (6, 'Chemistry', 'chemistry', 5),
  (7, 'Biology', 'biology', 6),
  (8, 'ICT', 'ict', 7),
  (9, 'Accounting', 'accounting', 8),
  (10, 'Finance', 'finance', 9),
  (11, 'Economics', 'economics', 10),
  (12, 'General Science', 'general-science', 11),
  (13, 'Religion', 'religion', 12),
  (14, 'Arabic', 'arabic', 13)
ON CONFLICT DO NOTHING;

-- Explicit ids don't advance the serial sequences; move them past the rows above.
SELECT setval(pg_get_serial_sequence('area', 'id'), (SELECT MAX(id) FROM "area"));
SELECT setval(pg_get_serial_sequence('subject', 'id'), (SELECT MAX(id) FROM "subject"));
