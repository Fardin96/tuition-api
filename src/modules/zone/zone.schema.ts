import { z } from "zod";

// Bangladesh bounding box, the same as the zone_in_bd CHECK.
const latSchema = z.number().min(20.5).max(26.7);
const lngSchema = z.number().min(88).max(92.7);
const radiusSchema = z.number().int().min(1000).max(5000);
const labelSchema = z.string().trim().min(1).max(60);
const placeIdSchema = z.string().min(1).max(255);
const addressTextSchema = z.string().trim().min(1).max(500);

export const ZONE_LIMIT_MAX = 50;

export const zoneIdParamSchema = z.object({ id: z.string().uuid() });
export type ZoneIdParam = z.infer<typeof zoneIdParamSchema>;

export const createZoneSchema = z
  .object({
    label: labelSchema,
    lat: latSchema,
    lng: lngSchema,
    radiusM: radiusSchema,
    placeId: placeIdSchema.optional(),
    addressText: addressTextSchema.optional(),
  })
  .strict();
export type CreateZoneInput = z.infer<typeof createZoneSchema>;

export const updateZoneSchema = z
  .object({
    label: labelSchema,
    lat: latSchema,
    lng: lngSchema,
    radiusM: radiusSchema,
    placeId: placeIdSchema.nullable(),
    addressText: addressTextSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required")
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: "lat and lng must be sent together",
    path: ["lat"],
  });
export type UpdateZoneInput = z.infer<typeof updateZoneSchema>;

export const zoneResponseSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  lat: z.number(),
  lng: z.number(),
  radiusM: z.number(),
  placeId: z.string().nullable(),
  addressText: z.string().nullable(),
  requirementIds: z.array(z.string().uuid()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ZoneResponse = z.infer<typeof zoneResponseSchema>;

const zoneRequestStatusSchema = z.enum(["PENDING", "APPROVED", "DENIED"]);

export const zoneLimitRequestResponseSchema = z.object({
  id: z.string().uuid(),
  requestedLimit: z.number(),
  reason: z.string(),
  status: zoneRequestStatusSchema,
  decisionNote: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ZoneLimitRequestResponse = z.infer<typeof zoneLimitRequestResponseSchema>;

export const zoneListResponseSchema = z.object({
  zones: z.array(zoneResponseSchema),
  limit: z.number(),
  used: z.number(),
  pendingRequest: zoneLimitRequestResponseSchema.nullable(),
});

export const zoneDeleteResponseSchema = z.object({
  id: z.string().uuid(),
  affectedRequirements: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      isDefault: z.boolean(),
      isActive: z.boolean(),
      teachesOnline: z.boolean(),
      remainingZoneCount: z.number(),
    }),
  ),
});

export const createZoneLimitRequestSchema = z
  .object({
    requestedLimit: z.number().int().min(6).max(ZONE_LIMIT_MAX),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();
export type CreateZoneLimitRequestInput = z.infer<typeof createZoneLimitRequestSchema>;

export const zoneLimitRequestListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type ZoneLimitRequestListQuery = z.infer<typeof zoneLimitRequestListQuerySchema>;

export const zoneLimitRequestListResponseSchema = z.object({
  requests: z.array(zoneLimitRequestResponseSchema),
  nextCursor: z.string().nullable(),
});

// Admin queue (#135, #136)

export const adminZoneRequestListQuerySchema = z.object({
  status: zoneRequestStatusSchema.default("PENDING"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminZoneRequestListQuery = z.infer<typeof adminZoneRequestListQuerySchema>;

export const adminZoneRequestResponseSchema = zoneLimitRequestResponseSchema.extend({
  tutor: z.object({
    id: z.string().uuid(),
    name: z.string(),
    zoneLimit: z.number(),
    zonesUsed: z.number(),
  }),
});
export type AdminZoneRequestResponse = z.infer<typeof adminZoneRequestResponseSchema>;

export const adminZoneRequestListResponseSchema = z.object({
  requests: z.array(adminZoneRequestResponseSchema),
  nextCursor: z.string().nullable(),
});

export const decideZoneRequestSchema = z
  .object({
    decision: z.enum(["APPROVE", "DENY"]),
    approvedLimit: z.number().int().min(6).max(ZONE_LIMIT_MAX).optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => v.decision === "APPROVE" || v.approvedLimit === undefined, {
    message: "approvedLimit is only allowed with APPROVE",
    path: ["approvedLimit"],
  });
export type DecideZoneRequestInput = z.infer<typeof decideZoneRequestSchema>;
