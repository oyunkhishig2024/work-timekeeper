import { Controller, Get, HttpCode, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { ApiError } from "../common/api-error";
import { CONTENT_TYPES } from "../tabular/table";
import { toCsv, toXlsx } from "../tabular/write";
import { EmployeeImportService } from "./employee-import.service";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const importQuery = z.object({
  dryRun: bool.default("true"),
  mode: z.enum(["VALID_ONLY", "ABORT_ON_ERROR"]).default("VALID_ONLY"),
  onDuplicate: z.enum(["SKIP", "CREATE"]).default("SKIP"),
  createAccounts: bool.default("false"),
  fileName: z.string().trim().max(200).optional(),
});

/** Bulk import of employees (PRD 12.3). Registered before the `:employeeId` routes of EmployeesController. */
@Controller("employees/import")
export class EmployeeImportController {
  constructor(private readonly imports: EmployeeImportService) {}

  /** Import template (header and two example rows): `?format=xlsx` (default) or `csv`. */
  @Roles("ORG_ADMIN", "HR")
  @Get("template")
  async template(@Query() query: unknown, @CurrentAuth() auth: AuthContext, @Res() res: Response) {
    const { format } = z.object({ format: z.enum(["xlsx", "csv"]).default("xlsx") }).parse(query);
    const table = this.imports.template();
    const body = format === "csv" ? toCsv(table) : await toXlsx(table, auth.userId, new Date());
    res.setHeader("Content-Type", CONTENT_TYPES[format]);
    res.setHeader("Content-Disposition", `attachment; filename="employees_template.${format}"`);
    res.send(body);
  }

  /**
   * `.xlsx` or CSV as the raw request body (max 5 MB, 2,000 rows). `dryRun` defaults to true: nothing is written and the per-row
   * report is returned; send `dryRun=false` to import. `mode`: `VALID_ONLY` (default) or `ABORT_ON_ERROR`. `onDuplicate`: `SKIP`
   * (default) skips a new row whose name and department already exist, `CREATE` imports it anyway. `createAccounts=true` gives each
   * new employee a login and returns the one-time passwords once.
   */
  @Roles("ORG_ADMIN", "HR")
  @Post()
  @HttpCode(200)
  run(
    @CurrentAuth() auth: AuthContext,
    @Query() query: unknown,
    @Req() req: Request,
    @Meta() meta: RequestMeta,
  ) {
    const q = importQuery.parse(query);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ApiError(
        415,
        "UNSUPPORTED_FILE_TYPE",
        "Send the file as the raw request body (.xlsx or CSV).",
      );
    }
    return this.imports.run(auth, req.body, q, meta);
  }
}
