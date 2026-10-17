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

/** The phone sends its token in the body; the web app sends nothing and the httpOnly cookie carries it (refresh-cookie.ts). */
export const refreshSchema = z.object({ refreshToken: z.string().min(1).optional() });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

export const totpEnableSchema = z.object({ code: z.string().trim().min(1).max(16) });
