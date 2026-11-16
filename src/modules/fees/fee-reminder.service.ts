// Payment reminders for PLACEMENT fees.
//
// Rule: a confirmed application creates a PLACEMENT fee due FEE_DUE_IN_DAYS
// (7) after confirmation. From the due date until FEE_UNPAID_AFTER_DAYS (21)
// days after application.confirmed_at, the tutor gets one PAYMENT_REMINDER per
// Asia/Dhaka day while the fee is DUE or PARTIAL. After that the reminders stop
// and the fee reads as "Unpaid" (derived in the API, never stored); payment is
// still accepted.
//
// One outbox row per fee per day. dedupe_key makes re-runs on the same day a no-op.

import { prisma } from "../../lib/prisma.js";
import { FEE_UNPAID_AFTER_DAYS } from "../application/application.schema.js";

export async function runFeeReminders(now = new Date()): Promise<{ queued: number }> {
  const queued = await prisma.$executeRaw`
    WITH clock AS (
      SELECT (${now}::timestamptz AT TIME ZONE 'Asia/Dhaka')::date AS today
    )
    INSERT INTO notification_log
      (id, event_type, channel, recipient_account_id, application_id, dedupe_key, template_name, payload)
    SELECT
      gen_random_uuid(),
      'PAYMENT_REMINDER'::"NotificationEvent",
      'WHATSAPP'::"NotificationChannel",
      t.account_id,
      f.application_id,
      'payment_reminder:' || f.id || ':' || to_char(c.today, 'YYYY-MM-DD'),
      'payment_reminder',
      jsonb_build_object(
        'feeId', f.id,
        'applicationId', f.application_id,
        'amountDue', f.amount_due,
        'amountPaid', f.amount_paid,
        'dueDate', f.due_date
      )
    FROM clock c
    CROSS JOIN platform_fee f
    JOIN application a ON a.id = f.application_id
    JOIN tutor t ON t.id = f.tutor_id
    WHERE f.fee_type = 'PLACEMENT'
      AND f.status IN ('DUE'::"FeeStatus", 'PARTIAL'::"FeeStatus")
      AND f.due_date <= c.today
      AND a.confirmed_at + make_interval(days => ${FEE_UNPAID_AFTER_DAYS}::int) > ${now}::timestamptz
    ON CONFLICT (dedupe_key) DO NOTHING
  `;

  return { queued };
}
