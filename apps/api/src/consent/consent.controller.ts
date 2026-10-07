import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "../common/api-error";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { ConsentService } from "./consent.service";

const id = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Use YYYY-MM-DD");

const createTextSchema = z.object({
  version: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/u),
  body: z.string().min(50).max(20_000),
  isDraft: z.boolean().default(true),
});
const printSchema = z.object({ employeeIds: z.array(id).min(1).max(500) });
const markSignedSchema = z.object({
  formCode: z.string().trim().min(5).max(40),
  signedOn: isoDate,
});
const withdrawSchema = z.object({
  withdrawnOn: isoDate,
  note: z.string().trim().max(500).optional(),
});
const overviewSchema = z.object({
  status: z.enum(["NOT_REQUESTED", "PRINTED", "SIGNED", "WITHDRAWN"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller()
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  // ---- consent texts: Org Admin

  @Roles("ORG_ADMIN", "HR")
  @Get("consent/texts")
  listTexts(@CurrentAuth() auth: AuthContext) {
    return this.consent.listTexts(auth);
  }

  @Roles("ORG_ADMIN")
  @Post("consent/texts")
  createText(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.consent.createText(auth, createTextSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Post("consent/texts/:textId/activate")
  @HttpCode(200)
  activateText(
    @CurrentAuth() auth: AuthContext,
    @Param("textId") textId: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.consent.activateText(auth, id.parse(textId), meta);
  }

  // ---- printing and recording: HR and Org Admin

  /** Returns the PDF (one A4 page per form). Headers say how many forms were printed and skipped. */
  @Roles("ORG_ADMIN", "HR")
  @Post("consent/print")
  @HttpCode(200)
  async print(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.consent.print(auth, printSchema.parse(body).employeeIds, meta);
    res
      .status(200)
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="consent-forms.pdf"',
        "X-Consent-Printed": String(result.printed.length),
        "X-Consent-Skipped": String(result.skipped.length),
        "Cache-Control": "no-store",
      })
      .send(result.pdf);
  }

  @Roles("ORG_ADMIN", "HR")
  @Post("consent/records/mark-signed")
  @HttpCode(200)
  markSigned(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.consent.markSigned(auth, markSignedSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN", "HR")
  @Post("employees/:employeeId/consent/withdraw")
  @HttpCode(200)
  withdraw(
    @CurrentAuth() auth: AuthContext,
    @Param("employeeId") employeeId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.consent.withdraw(auth, id.parse(employeeId), withdrawSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN", "HR")
  @Get("employees/:employeeId/consent")
  forEmployee(@CurrentAuth() auth: AuthContext, @Param("employeeId") employeeId: string) {
    return this.consent.forEmployee(auth, id.parse(employeeId));
  }

  @Roles("ORG_ADMIN", "HR")
  @Get("consent/overview")
  overview(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.consent.overview(auth, overviewSchema.parse(query));
  }

  // ---- scan of the signed paper (raw body: application/pdf, image/jpeg or image/png, max 10 MB)

  @Roles("ORG_ADMIN", "HR")
  @Put("consent/records/:recordId/scan")
  async uploadScan(
    @CurrentAuth() auth: AuthContext,
    @Param("recordId") recordId: string,
    @Req() req: Request,
    @Meta() meta: RequestMeta,
  ) {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ApiError(
        415,
        "UNSUPPORTED_FILE_TYPE",
        "Send the file as the raw request body (PDF, JPEG or PNG).",
      );
    }
    return this.consent.uploadScan(auth, id.parse(recordId), req.body, meta);
  }

  @Roles("ORG_ADMIN", "HR")
  @Get("consent/records/:recordId/scan")
  async downloadScan(
    @CurrentAuth() auth: AuthContext,
    @Param("recordId") recordId: string,
    @Meta() meta: RequestMeta,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.consent.downloadScan(auth, id.parse(recordId), meta);
    res
      .status(200)
      .set({
        "Content-Type": file.contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      })
      .send(file.data);
  }
}
