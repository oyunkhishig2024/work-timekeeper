import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, loadConfig } from "../common/config";
import { Clock, SystemClock } from "../common/clock";
import { DatabaseService } from "./database.service";

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: Clock, useClass: SystemClock },
    DatabaseService,
  ],
  exports: [APP_CONFIG, Clock, DatabaseService],
})
export class DatabaseModule {}
