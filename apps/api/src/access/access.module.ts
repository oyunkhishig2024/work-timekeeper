import { Global, Module } from "@nestjs/common";
import { ScopeService } from "./scope.service";

@Global()
@Module({ providers: [ScopeService], exports: [ScopeService] })
export class AccessModule {}
