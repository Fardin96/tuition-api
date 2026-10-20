# Masters Hub / Tuition Media: required endpoints (schema v5)

Base path `/api/v1`. Auth: P = public, S = student, T = tutor, A = admin, SA = super admin, any = any signed-in account.
Notes: `GET /me` returns the account plus its profile (student, tutor or admin), so there is no separate `GET /students/me` or `GET /tutors/me`. Notification sending is done by a background worker, not an endpoint. Lookups for `area` are seeded; no endpoint to edit them.

## 1. Auth and account (11)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 1 | POST | /auth/google | P | Exchange Google ID token; creates the account on first call (role chosen here; ADMIN starts PENDING); returns access + refresh token |
| 2 | POST | /auth/refresh | P | Rotate refresh token (session) |
| 3 | POST | /auth/logout | any | Revoke current session |
| 4 | POST | /auth/logout-all | any | Revoke all sessions |
| 5 | GET | /auth/sessions | any | List signed-in devices |
| 6 | DELETE | /auth/sessions/:id | any | Revoke one device |
| 7 | POST | /auth/consent | S, T | Record consent version + time |
| 8 | GET | /me | any | Account + profile |
| 9 | DELETE | /me | any | Soft-delete account |
| 10 | POST | /me/whatsapp/otp | S, T | Send WhatsApp OTP |
| 11 | POST | /me/whatsapp/verify | S, T | Verify OTP, set whatsapp_verified_at |

## 2. Files (4)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 12 | POST | /files/upload-url | any | Create file_asset (PENDING_UPLOAD) + presigned URL |
| 13 | POST | /files/:id/complete | any | Mark UPLOADED |
| 14 | GET | /files/:id/download-url | owner, A | Short-lived read URL |
| 15 | DELETE | /files/:id | owner, A | Mark DELETED |

## 3. Lookups (7)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 16 | GET | /areas | P | Division > district > area |
| 17 | GET | /categories | P | Active categories |
| 18 | GET | /subjects | P | Active subjects |
| 19 | POST | /admin/categories | A | Create category |
| 20 | PATCH | /admin/categories/:id | A | Edit / deactivate |
| 21 | POST | /admin/subjects | A | Create subject |
| 22 | PATCH | /admin/subjects/:id | A | Edit / deactivate |

## 4. Student (5)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 23 | POST | /students/me | S | Create profile |
| 24 | PATCH | /students/me | S | Update profile |
| 25 | POST | /students/me/verification | S | Submit ID file for verification |
| 26 | GET | /students/:id | T (with an application), A | Limited student profile + rating |
| 27 | GET | /students/:id/reviews | T, A | Reviews given to a student |

## 5. Tutor (16)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 28 | POST | /tutors/me | T | Create profile |
| 29 | PATCH | /tutors/me | T | Update profile |
| 30 | PUT | /tutors/me/areas | T | Replace tutor_area set |
| 31 | PUT | /tutors/me/subjects | T | Replace tutor_subject set |
| 32 | POST | /tutors/me/verifications | T | Submit verification (one PENDING at a time) |
| 33 | GET | /tutors/me/verifications | T | Submission history |
| 34 | GET | /tutors | P / S | Directory search (is_listed only; filters: area, subject, gender, rating, name) |
| 35 | GET | /tutors/:id | P / S | Public profile |
| 36 | GET | /tutors/:id/reviews | P / S | Reviews of a tutor |
| 37 | GET | /tutors/me/credentials | T | List credentials |
| 38 | POST | /tutors/me/credentials | T | Add credential |
| 39 | DELETE | /tutors/me/credentials/:id | T | Remove credential |
| 40 | GET | /tutors/me/videos | T | Own videos (any moderation state) |
| 41 | POST | /tutors/me/videos | T | Add video (PENDING) |
| 42 | DELETE | /tutors/me/videos/:id | T | Remove video |
| 43 | GET | /videos | P | Approved videos |

## 6. Requirements (6)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 44 | POST | /requirements | S | Create |
| 45 | GET | /requirements | T | Browse OPEN requirements (filters) |
| 46 | GET | /requirements/mine | S | Own requirements |
| 47 | GET | /requirements/:id | S owner, T, A | Detail |
| 48 | PATCH | /requirements/:id | S owner | Edit |
| 49 | POST | /requirements/:id/close | S owner | Close |

## 7. Packages (6)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 50 | POST | /packages | T | Create (moderation PENDING) |
| 51 | GET | /packages | S | Browse OPEN + APPROVED packages |
| 52 | GET | /packages/mine | T | Own packages (any moderation state) |
| 53 | GET | /packages/:id | S, T owner, A | Detail |
| 54 | PATCH | /packages/:id | T owner | Edit (resets moderation to PENDING) |
| 55 | POST | /packages/:id/close | T owner | Close |

## 8. Applications (12)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 56 | POST | /requirements/:id/applications | T | Tutor applies |
| 57 | POST | /packages/:id/applications | S | Student takes a package |
| 58 | GET | /applications | S, T | Own applications (status filter) |
| 59 | GET | /applications/:id | parties, A | Detail |
| 60 | GET | /requirements/:id/applications | S owner | Applicants of a requirement |
| 61 | GET | /packages/:id/applications | T owner | Requests on a package |
| 62 | POST | /applications/:id/confirm | counterparty | PENDING to CONFIRMED (creates fee + notification in same tx) |
| 63 | POST | /applications/:id/reject | counterparty | PENDING to REJECTED |
| 64 | POST | /applications/:id/withdraw | initiator | PENDING to WITHDRAWN |
| 65 | POST | /applications/:id/reopen | initiator | Retry a WITHDRAWN / REJECTED / EXPIRED row that never confirmed |
| 66 | POST | /applications/:id/cancel | parties | CONFIRMED to CANCELLED |
| 67 | POST | /applications/:id/complete | parties | CONFIRMED to COMPLETED (sets ended_at) |

## 9. Reviews (2)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 68 | POST | /reviews | S, T | Create (direction derived from caller; needs confirmed/completed match) |
| 69 | PATCH | /reviews/:id | author | Edit rating / comment |

## 10. Reports and disputes (4)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 70 | POST | /reports | any | File a report |
| 71 | GET | /reports/mine | any | Own reports |
| 72 | POST | /disputes | S, T | Dispute a confirmed/completed match |
| 73 | GET | /disputes/mine | S, T | Own disputes |

## 11. Tutor fees (2)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 74 | GET | /fees/mine | T | Own fees (computed OVERDUE flag) |
| 75 | GET | /fees/:id | T owner | Fee + payment ledger |

## 12. Public content (3)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 76 | GET | /blog | P | Published posts |
| 77 | GET | /blog/:slug | P | One post |
| 78 | GET | /site-content | P | All landing-page blocks |

## 13. Admin (40)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 79 | GET | /admin/admins | A | List admins |
| 80 | POST | /admin/admins/:id/approve | SA | PENDING to ACTIVE |
| 81 | POST | /admin/admins/:id/remove | SA | Remove admin |
| 82 | POST | /admin/mfa/setup | A | Begin MFA enrolment |
| 83 | POST | /admin/mfa/verify | A | Confirm MFA |
| 84 | GET | /admin/accounts | A | Search accounts |
| 85 | GET | /admin/accounts/:id | A | Account detail |
| 86 | POST | /admin/accounts/:id/block | SA | Block (reason required) |
| 87 | POST | /admin/accounts/:id/unblock | SA | Unblock |
| 88 | GET | /admin/verifications/tutors | A | Tutor review queue |
| 89 | POST | /admin/verifications/tutors/:id/decide | A | Approve / reject (rejection needs a note) |
| 90 | GET | /admin/verifications/students | A | Student review queue |
| 91 | POST | /admin/verifications/students/:id/decide | A | Approve / reject |
| 92 | GET | /admin/packages | A | Packages by moderation status |
| 93 | POST | /admin/packages/:id/moderate | A | Approve / reject |
| 94 | GET | /admin/videos | A | Videos by moderation status |
| 95 | POST | /admin/videos/:id/moderate | A | Approve / reject |
| 96 | PATCH | /admin/reviews/:id | A | Hide / show |
| 97 | GET | /admin/reports | A | Report queue |
| 98 | GET | /admin/reports/:id | A | Report detail |
| 99 | PATCH | /admin/reports/:id | A | Assign, resolve, dismiss |
| 100 | GET | /admin/disputes | A | Dispute queue |
| 101 | GET | /admin/disputes/:id | A | Dispute detail |
| 102 | PATCH | /admin/disputes/:id | A | Assign, resolve, dismiss |
| 103 | GET | /admin/applications | A | Read-only application list |
| 104 | POST | /admin/fees | A | Create fee |
| 105 | GET | /admin/fees | A | List (status, tutor, overdue filters) |
| 106 | GET | /admin/fees/:id | A | Fee + ledger |
| 107 | PATCH | /admin/fees/:id | A | Due date, note, WAIVED / VOID |
| 108 | POST | /admin/fees/:id/payments | A | Record payment |
| 109 | POST | /admin/payments/:id/reverse | A | Record reversal (reason required) |
| 110 | GET | /admin/blog | A | All posts incl. drafts |
| 111 | GET | /admin/blog/:id | A | One post |
| 112 | POST | /admin/blog | A | Create post |
| 113 | PATCH | /admin/blog/:id | A | Edit / publish / archive |
| 114 | DELETE | /admin/blog/:id | A | Delete draft |
| 115 | PUT | /admin/site-content/:key | A | Upsert landing-page block |
| 116 | GET | /admin/audit-logs | A | Filter by entity / actor |
| 117 | GET | /admin/notifications | A | FAILED / DEAD outbox rows |
| 118 | POST | /admin/notifications/:id/retry | A | Requeue |

## 14. System (2)
| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 119 | POST | /webhooks/whatsapp-status | n8n (signed) | Delivery receipts: update status / provider_message_id |
| 120 | GET | /health | P | Liveness |

## Total: 120 endpoints
Auth 11, Files 4, Lookups 7, Student 5, Tutor 16, Requirements 6, Packages 6, Applications 12, Reviews 2, Reports/Disputes 4, Fees (tutor) 2, Public content 3, Admin 40, System 2.
