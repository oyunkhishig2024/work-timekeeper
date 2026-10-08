import { Global, Module } from "@nestjs/common";
import { LocalDiskStorage, ObjectStorage } from "./object-storage";

@Global()
@Module({
  providers: [{ provide: ObjectStorage, useClass: LocalDiskStorage }],
  exports: [ObjectStorage],
})
export class StorageModule {}
