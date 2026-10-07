import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { CurrentAuth, Meta, Roles } from "../auth/decorators";
import { JobCatalogService } from "./job-catalog.service";

const id = z.string().uuid();
const activeFilter = z.object({
  active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
const name = z.string().trim().min(1).max(120);
const sortOrder = z.number().int().min(1).max(10000);

const createRank = z.object({ name, sortOrder: sortOrder.optional() }).strict();
const updateRank = z
  .object({
    name: name.optional(),
    sortOrder: sortOrder.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
const createPosition = z.object({ name }).strict();
const updatePosition = z
  .object({ name: name.optional(), active: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

/** Ranks (цол), lowest first. Reading is open to Manager; changing the list is for the Org Admin. */
@Controller("ranks")
export class RanksController {
  constructor(private readonly catalog: JobCatalogService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.catalog.list(auth, "rank", activeFilter.parse(query));
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get(":rankId")
  get(@CurrentAuth() auth: AuthContext, @Param("rankId") rankId: string) {
    return this.catalog.get(auth, "rank", id.parse(rankId));
  }

  @Roles("ORG_ADMIN")
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.catalog.create(auth, "rank", createRank.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Patch(":rankId")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("rankId") rankId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.catalog.update(auth, "rank", id.parse(rankId), updateRank.parse(body), meta);
  }
}

/** Job positions (албан тушаал). */
@Controller("positions")
export class PositionsController {
  constructor(private readonly catalog: JobCatalogService) {}

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.catalog.list(auth, "position", activeFilter.parse(query));
  }

  @Roles("ORG_ADMIN", "HR", "MANAGER")
  @Get(":positionId")
  get(@CurrentAuth() auth: AuthContext, @Param("positionId") positionId: string) {
    return this.catalog.get(auth, "position", id.parse(positionId));
  }

  @Roles("ORG_ADMIN")
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.catalog.create(auth, "position", createPosition.parse(body), meta);
  }

  @Roles("ORG_ADMIN")
  @Patch(":positionId")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("positionId") positionId: string,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ) {
    return this.catalog.update(
      auth,
      "position",
      id.parse(positionId),
      updatePosition.parse(body),
      meta,
    );
  }
}
