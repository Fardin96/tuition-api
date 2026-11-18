import { writeAudit } from "../../lib/admin.js";
import { validationIssuesError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import {
  type PlatformSettingItem,
  SETTING_KEYS,
  type SettingKey,
  type SettingValue,
} from "./settings.schema.js";

// Used when a key has no platform_setting row yet.
const DEFAULTS: Record<SettingKey, SettingValue> = {
  commission_percent: 0,
  gateway_charge_percent: 0,
  online_payments_enabled: false,
  refund_window_days: 7,
  require_tutor_verification: false,
  require_phone_verification: false,
};

// Number settings and their allowed range. Decimals: at most 2 places (none for WHOLE_NUMBER_KEYS).
const NUMBER_RANGES: Partial<Record<SettingKey, { min: number; max: number }>> = {
  commission_percent: { min: 0, max: 100 },
  gateway_charge_percent: { min: 0, max: 10 },
  refund_window_days: { min: 0, max: 90 },
};

// Number settings that count whole units (days), so a fraction is refused.
const WHOLE_NUMBER_KEYS: SettingKey[] = ["refund_window_days"];

function readValue(key: SettingKey, raw: unknown): SettingValue {
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  return DEFAULTS[key];
}

function validateValue(key: SettingKey, value: SettingValue) {
  const range = NUMBER_RANGES[key];
  if (range) {
    if (typeof value !== "number" || !(value >= range.min && value <= range.max)) {
      throw validationIssuesError("Invalid setting value", [
        { path: "value", message: `${key} must be a number from ${range.min} to ${range.max}` },
      ]);
    }
    if (WHOLE_NUMBER_KEYS.includes(key) && !Number.isInteger(value)) {
      throw validationIssuesError("Invalid setting value", [
        { path: "value", message: `${key} must be a whole number of days` },
      ]);
    }
    // The tolerance absorbs float error in value * 100.
    if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
      throw validationIssuesError("Invalid setting value", [
        { path: "value", message: `${key} allows at most 2 decimal places` },
      ]);
    }
    return;
  }
  if (typeof value !== "boolean") {
    throw validationIssuesError("Invalid setting value", [
      { path: "value", message: `${key} must be true or false` },
    ]);
  }
}

export async function listPlatformSettings(): Promise<PlatformSettingItem[]> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: [...SETTING_KEYS] } },
    select: {
      key: true,
      value: true,
      updatedAt: true,
      updatedBy: { select: { name: true } },
    },
  });
  const byKey = new Map(rows.map((row) => [row.key, row] as const));

  return SETTING_KEYS.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      value: row ? readValue(key, row.value) : DEFAULTS[key],
      updatedAt: row?.updatedAt ?? null,
      updatedByName: row?.updatedBy?.name ?? null,
    };
  });
}

export async function updatePlatformSetting(
  key: SettingKey,
  value: SettingValue,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<PlatformSettingItem> {
  validateValue(key, value);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.platformSetting.findUnique({
      where: { key },
      select: { value: true },
    });
    const previous = existing ? readValue(key, existing.value) : DEFAULTS[key];

    const row = await tx.platformSetting.upsert({
      where: { key },
      create: { key, value, updatedById: admin.accountId },
      update: { value, updatedById: admin.accountId },
      select: { updatedAt: true, updatedBy: { select: { name: true } } },
    });

    // is_listed is written only by recompute_is_listed(); a rule change re-evaluates every tutor.
    if (key === "require_tutor_verification" && previous !== value) {
      await tx.$executeRaw`SELECT recompute_is_listed(t.id) FROM tutor t`;
    }

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "setting.update",
      entityType: "platform_setting",
      entityId: key,
      before: { value: previous },
      after: { value },
      ip: ip ?? null,
    });

    return {
      key,
      value,
      updatedAt: row.updatedAt,
      updatedByName: row.updatedBy?.name ?? null,
    };
  });
}
