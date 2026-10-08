import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { DevicesService } from "./devices.service";

const id = z.string().uuid();
const hours = z.number().int().min(1).max(720);

const onboardingQrSchema = z.object({
  label: z.string().trim().max(120).optional(),
  expiresInHours: hours.optional(),
  maxUses: z.number().int().min(1).max(5000).optional(),
});
const replacementQrSchema = z.object({
  expiresInHours: hours.optional(),
  consentOverrideReason: z.string().trim().min(5).max(500).optional(),
});
const regenerateQrSchema = z.object({ expiresInHours: hours.optional() }).strict();
const registerSchema = z.object({
  qrToken: z.string().min(10).max(300),
  platform: z.enum(["ANDROID", "IOS"]),
  model: z.string().trim().max(120).optional(),
  osVersion: z.string().trim().max(60).optional(),
  appVersion: z.string().trim().max(60).optional(),
  attestationKeyId: z.string().trim().min(1).max(512).optional(),
  publicKey: z.string().trim().min(1).max(4096).optional(),
  attestationToken: z.string().min(1).max(20_000).optional(),
});
const disableSchema = z.object({
  reason: z.enum(["LOST", "STOLEN", "OTHER"]),
  note: z.string().trim().max(500).optional(),
});

@Controller()
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  // ---- QR codes: HR and Org Admin

  @Roles("ORG_ADMIN", "HR")
  @Post("qr/onboarding")
  createOnboardingQr(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.devices.createOnboardingQr(auth, onboardingQrSchema.parse(body ?? {}), meta);
  }

  @Roles("ORG_ADMIN", "HR")
  @Post("employees/:employeeId/replacement-qr")
  createReplacementQr(
    @CurrentAuth() auth: AuthContext,
    @Param("employeeId") employeeId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.devices.createReplacementQr(
      auth,
      id.parse(employeeId),
      replacementQrSchema.parse(body ?? {}),
      meta,
    );
  }

  @Roles("ORG_ADMIN", "HR")
  @Get("qr")
  listOpenQr(@CurrentAuth() auth: AuthContext) {
    return this.devices.listOpenQr(auth);
  }

  @Roles("ORG_ADMIN", "HR")
  @Post("qr/:qrId/regenerate")
  @HttpCode(201)
  regenerateQr(
    @CurrentAuth() auth: AuthContext,
    @Param("qrId") qrId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.devices.regenerateOnboardingQr(
      auth,
      id.parse(qrId),
      regenerateQrSchema.parse(body ?? {}),
      meta,
    );
  }

  @Roles("ORG_ADMIN", "HR")
  @Post("qr/:qrId/cancel")
  @HttpCode(200)
  cancelQr(
    @CurrentAuth() auth: AuthContext,
    @Param("qrId") qrId: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.devices.cancelQr(auth, id.parse(qrId), meta);
  }

  // ---- the employee's phone

  @Roles("EMPLOYEE")
  @Post("devices/register")
  register(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.devices.register(auth, registerSchema.parse(body), meta);
  }

  @Roles("EMPLOYEE")
  @Get("devices/me")
  myDevice(@CurrentAuth() auth: AuthContext) {
    return this.devices.myDevice(auth);
  }

  // ---- device management: HR and Org Admin

  @Roles("ORG_ADMIN", "HR")
  @Post("devices/:deviceId/disable")
  @HttpCode(200)
  disable(
    @CurrentAuth() auth: AuthContext,
    @Param("deviceId") deviceId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.devices.disableDevice(auth, id.parse(deviceId), disableSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN", "HR")
  @Get("employees/:employeeId/devices")
  listForEmployee(@CurrentAuth() auth: AuthContext, @Param("employeeId") employeeId: string) {
    return this.devices.listForEmployee(auth, id.parse(employeeId));
  }
}
