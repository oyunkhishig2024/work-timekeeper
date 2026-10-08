import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { loadConfig } from "./common/config";
import { applyAbuseProtection } from "./security/apply";
import { parseTrustProxy } from "./security/trust-proxy";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // The service runs behind a reverse proxy (nginx, itself behind the WAF/CDN): trust only that hop's X-Forwarded-For
  // for the client IP, which rate limiting, bans and audit entries rely on (TRUST_PROXY, see docs/security).
  app.set("trust proxy", parseTrustProxy(config.TRUST_PROXY));
  applyAbuseProtection(app); // first: before anything else answers, including unknown URLs
  app.use(helmet());
  app.setGlobalPrefix("v1");
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
}

void bootstrap();
