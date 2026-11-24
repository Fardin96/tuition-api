import type { Prisma } from "../../generated/prisma/client.js";
import { appError } from "../../lib/errors.js";
import type { SettingKey } from "../admin/settings.schema.js";
import { DEFAULTS } from "../admin/settings.service.js";

type Db = Prisma.TransactionClient;
export type DailyKind = "application" | "package_request" | "accept";
export type DailyParty = { tutorId: string } | { studentId: string };

const SETTING_KEY: Record<DailyKind, SettingKey> = {
  application: "daily_application_limit",
  package_request: "daily_package_request_limit",
  accept: "daily_accept_limit",
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// A tutor only ever confirms package requests; a student confirms applications.
const MESSAGE: Record<DailyKind, (limit: number, tutor: boolean) => string> = {
  application: (limit) =>
    `You can send ${count(limit, "application", "applications")} in 24 hours.`,
  package_request: (limit) => `You can request ${count(limit, "package", "packages")} in 24 hours.`,
  accept: (limit, tutor) =>
    `You can accept ${tutor ? count(limit, "package request", "package requests") : count(limit, "application", "applications")} in 24 hours.`,
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Counts sends and accepts per account in a rolling 24 hours. Each one is a daily_action row, so a
// reopen or a withdrawn row still counts. Callers lock their listing and application rows first;
// the advisory lock then serialises concurrent sends by the same account.
export async function recordDailyAction(tx: Db, kind: DailyKind, party: DailyParty): Promise<void> {
  const partyId = "tutorId" in party ? party.tutorId : party.studentId;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`daily:${kind}:${partyId}`}))`;

  // shortcut: rows of accounts that never act again stay until they do; add a cron prune if the table grows.
  await tx.$executeRaw`
    DELETE FROM daily_action
    WHERE party_id = ${partyId}::uuid AND kind = ${kind} AND at <= now() - interval '24 hours'
  `;

  const [setting] = await tx.$queryRaw<{ max: Prisma.Decimal | null }[]>`
    SELECT (value #>> '{}')::numeric AS max
    FROM platform_setting
    WHERE key = ${SETTING_KEY[kind]}
  `;
  const limit = Number(setting?.max ?? DEFAULTS[SETTING_KEY[kind]]);

  // The newest row past the limit's offset decides: once it ages out, the count drops below the limit.
  const [blocking] = await tx.$queryRaw<{ at: Date }[]>`
    SELECT at FROM daily_action
    WHERE party_id = ${partyId}::uuid AND kind = ${kind}
    ORDER BY at DESC
    OFFSET ${limit - 1}::int
    LIMIT 1
  `;
  if (blocking) {
    throw appError("DailyLimitReached", 429, MESSAGE[kind](limit, "tutorId" in party), {
      limit,
      resetsAt: new Date(blocking.at.getTime() + DAY_MS).toISOString(),
    });
  }

  await tx.$executeRaw`INSERT INTO daily_action (party_id, kind) VALUES (${partyId}::uuid, ${kind})`;
}
