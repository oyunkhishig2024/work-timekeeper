import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { loadConfig } from "./common/config";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // The service runs behind one reverse proxy / load balancer: trust its X-Forwarded-For for client IPs
  // (rate limiting and audit entries).
  app.set("trust proxy", 1);
  app.use(helmet());
  app.setGlobalPrefix("v1");
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
}

void bootstrap();
