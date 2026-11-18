import { z } from "zod";

// Known platform_setting keys, in the order the admin list returns them.
export const SETTING_KEYS = [
  "commission_percent",
  "require_tutor_verification",
  "require_phone_verification",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const settingValueSchema = z.union([z.number(), z.boolean()]);
export type SettingValue = z.infer<typeof settingValueSchema>;

export const settingKeyParamSchema = z.object({ key: z.enum(SETTING_KEYS) });
export type SettingKeyParam = z.infer<typeof settingKeyParamSchema>;

export const platformSettingItemSchema = z
  .object({
    key: z.enum(SETTING_KEYS),
    value: settingValueSchema,
    updatedAt: z.date().nullable(),
    updatedByName: z.string().nullable(),
  })
  .meta({ id: "PlatformSettingItem" });
export type PlatformSettingItem = z.infer<typeof platformSettingItemSchema>;

export const platformSettingListSchema = z
  .object({ settings: z.array(platformSettingItemSchema) })
  .meta({ id: "PlatformSettingList" });

export const updateSettingSchema = z
  .object({ value: settingValueSchema })
  .strict()
  .meta({ id: "UpdateSetting" });
export type UpdateSettingInput = z.infer<typeof updateSettingSchema>;
