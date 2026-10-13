import { RequestMethod } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { ModulesContainer } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANY_ROLE, IS_PUBLIC, ROLES } from "../../src/auth/decorators";
import { hasDb } from "../db/helpers";
import { type Harness, startHarness } from "./harness";

/** Every route of the API says who may call it: @Roles, @AnyRole or @Public. Adding a route without one fails here. */
describe.skipIf(!hasDb)("route policy", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("every route declares who may call it", async () => {
    const routes: string[] = [];
    const undeclared: string[] = [];
    for (const module of h.app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as (new () => object) | null;
        if (!controller || Reflect.getMetadata(PATH_METADATA, controller) === undefined) continue;
        const proto = controller.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = proto[name];
          if (
            typeof handler !== "function" ||
            Reflect.getMetadata(METHOD_METADATA, handler) === undefined
          )
            continue;
          const label = `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]} ${controller.name}.${name}`;
          routes.push(label);
          const declared = [ROLES, ANY_ROLE, IS_PUBLIC].some(
            (key) =>
              Reflect.getMetadata(key, handler) !== undefined ||
              Reflect.getMetadata(key, controller) !== undefined,
          );
          if (!declared) undeclared.push(label);
        }
      }
    }
    expect(routes.length).toBeGreaterThan(100);
    expect(undeclared).toEqual([]);
  });
});
