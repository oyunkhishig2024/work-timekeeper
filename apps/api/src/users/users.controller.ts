import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { UsersService } from "./users.service";

const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/u, "Only letters, digits, dot, underscore and dash"),
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(["HR", "MANAGER"]),
});
const idSchema = z.string().uuid();

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Org Admin creates HR and Manager users (PRD 4). Returns a one-time temporary password. */
  @Roles("ORG_ADMIN")
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.users.create(
      auth.tenantId,
      createUserSchema.parse(body),
      { userId: auth.userId, role: auth.role },
      meta,
    );
  }

  @Roles("ORG_ADMIN", "HR")
  @Post(":id/reset-password")
  @HttpCode(200)
  resetPassword(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.users.resetPassword(auth, idSchema.parse(id), meta);
  }

  @Roles("ORG_ADMIN")
  @Post(":id/totp-reset")
  @HttpCode(200)
  resetTotp(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Meta() meta: RequestMeta) {
    return this.users.resetTotp(auth, idSchema.parse(id), meta);
  }
}
