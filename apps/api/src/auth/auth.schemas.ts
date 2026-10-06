import { z } from "zod";

export const loginSchema = z.object({
  orgCode: z.string().trim().min(1).max(64),
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(256),
});

export const totpVerifySchema = z
  .object({
    challengeToken: z.string().min(1),
    code: z.string().trim().optional(),
    recoveryCode: z.string().trim().optional(),
  })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), {
    message: "Provide exactly one of code or recoveryCode",
  });

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

export const totpEnableSchema = z.object({ code: z.string().trim().min(1).max(16) });
