import { z } from "zod";
import { toDistrictCode } from "../../lib/districts.js";

export const locationSchema = z
  .object({
    lat: z.number().min(20.5).max(26.7),
    lng: z.number().min(88).max(92.7),
    addressText: z.string().trim().min(1).max(500),
    district: z.string().min(1).max(100),
    placeId: z.string().min(1).max(255).optional(),
  })
  .transform(({ district, ...rest }, ctx) => {
    const districtCode = toDistrictCode(district);
    if (!districtCode) {
      ctx.addIssue({ code: "custom", message: "Unknown district", path: ["district"] });
      return z.NEVER;
    }
    return { ...rest, districtCode };
  });

export type LocationInput = z.output<typeof locationSchema>;

export const ownLocationResponseSchema = z
  .object({
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    addressText: z.string(),
    districtCode: z.string(),
    placeId: z.string().nullable(),
    needsReaddress: z.boolean(),
  })
  .nullable();
