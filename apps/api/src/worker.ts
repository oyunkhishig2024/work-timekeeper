import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";
import { loadConfig } from "./common/config";

async function bootstrap(): Promise<void> {
  loadConfig();
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}

void bootstrap();
