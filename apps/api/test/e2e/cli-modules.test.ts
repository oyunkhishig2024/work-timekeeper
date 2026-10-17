import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { ConsentCliModule, PlatformCliModule, UserCliModule } from "../../src/cli/cli-modules";
import { ConsentService } from "../../src/consent/consent.service";
import { PlatformAuthService } from "../../src/platform/platform-auth.service";
import { UsersService } from "../../src/users/users.service";
import { hasDb } from "../db/helpers";

// The command-line tools (create-user, reset-password, create-platform-user, load-consent-text) start their own small
// module, not AppModule. Each one must be able to build every service it uses; before this test, create-user,
// reset-password and create-platform-user crashed on the server because UsersService needed ScopeService (global AccessModule).
describe.skipIf(!hasDb)("command-line tool modules", () => {
  it.each([
    ["create-user and reset-password", UserCliModule, UsersService],
    ["create-platform-user", PlatformCliModule, PlatformAuthService],
    ["load-consent-text", ConsentCliModule, ConsentService],
  ] as const)("%s can build its services", async (_name, module, service) => {
    const built = await Test.createTestingModule({ imports: [module] }).compile();
    try {
      expect(built.get(service as never, { strict: false })).toBeDefined();
    } finally {
      await built.close();
    }
  });
});
