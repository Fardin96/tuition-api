import { z } from "zod";
import type { Role } from "../../generated/prisma/enums.js";

export const roleSchema = z.enum(["STUDENT", "TUTOR", "ADMIN"] as const);

export const googleAuthSchema = z.object({
  idToken: z.string().min(1),
  role: roleSchema,
  consentVersion: z.string().optional(),
});

export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export type RefreshInput = z.infer<typeof refreshSchema>;

export const consentSchema = z.object({
  version: z.string().min(1),
});

export type ConsentInput = z.infer<typeof consentSchema>;

export const tokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  account: z.object({
    id: z.string(),
    role: z.string(),
    email: z.string(),
    status: z.string(),
  }),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export type AuthContext = {
  accountId: string;
  role: Role;
  email: string;
};
