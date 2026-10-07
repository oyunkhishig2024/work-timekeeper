import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { DepartmentsService } from "./departments.service";
import { LocationsService } from "./locations.service";

const id = z.string().uuid();
const activeFilter = z.object({
  active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
const name = z.string().trim().min(1).max(120);

const createDepartmentSchema = z.object({ name }).strict();
const updateDepartmentSchema = z
  .object({ name: name.optional(), active: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

const locationFields = {
  name,
  address: z.string().trim().max(300).nullable().optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  // PRD 13: geofence radius 100–500 m.
  radiusM: z.number().int().min(100).max(500),
  workingWeekMode: z.enum(["INHERIT", "OVERRIDE"]).optional(),
};
const createLocationSchema = z.object(locationFields).strict();
const updateLocationSchema = z
  .object({ ...locationFields, active: z.boolean() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

/** Reading is open to Manager too; changing the organization structure is for the Org Admin (PRD 4). */
@Controller("departments")
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.departments.list(auth, activeFilter.parse(query));
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get(":departmentId")
  get(@CurrentAuth() auth: AuthContext, @Param("departmentId") departmentId: string) {
    return this.departments.get(auth, id.parse(departmentId));
  }

  @Roles("ORG_ADMIN")
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.departments.create(auth, createDepartmentSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Patch(":departmentId")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("departmentId") departmentId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.departments.update(
      auth,
      id.parse(departmentId),
      updateDepartmentSchema.parse(body),
      meta,
    );
  }

  @Roles("ORG_ADMIN")
  @Delete(":departmentId")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param("departmentId") departmentId: string,
    @Meta() meta: RequestMeta,
  ) {
    await this.departments.remove(auth, id.parse(departmentId), meta);
  }
}

@Controller("locations")
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.locations.list(auth, activeFilter.parse(query));
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get(":locationId")
  get(@CurrentAuth() auth: AuthContext, @Param("locationId") locationId: string) {
    return this.locations.get(auth, id.parse(locationId));
  }

  @Roles("ORG_ADMIN")
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.locations.create(auth, createLocationSchema.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Patch(":locationId")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("locationId") locationId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.locations.update(
      auth,
      id.parse(locationId),
      updateLocationSchema.parse(body),
      meta,
    );
  }

  @Roles("ORG_ADMIN")
  @Delete(":locationId")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param("locationId") locationId: string,
    @Meta() meta: RequestMeta,
  ) {
    await this.locations.remove(auth, id.parse(locationId), meta);
  }
}
