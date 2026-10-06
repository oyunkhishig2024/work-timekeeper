import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./common/config";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("v1");
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
}

void bootstrap();
