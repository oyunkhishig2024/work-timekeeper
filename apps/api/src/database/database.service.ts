import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import { APP_CONFIG, type AppConfig } from "../common/config";

export type Db = PoolClient;

/**
 * All tenant data access goes through here. Every transaction switches to the `app_user` role (no
 * BYPASSRLS) and sets the tenant, so Row-Level Security applies even if the connection itself is a
 * superuser (Architecture 5.2).
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
  }

  async withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
    return this.transaction(async (db) => {
      await db.query("SET LOCAL ROLE app_user");
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      return fn(db);
    });
  }

  /**
   * For service-wide tables that belong to no tenant (for example the IP block list). Runs as the `platform_admin`
   * role (no BYPASSRLS; it only has the grants those tables give it), never as a tenant session.
   */
  async asPlatform<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return this.transaction(async (db) => {
      await db.query("SET LOCAL ROLE platform_admin");
      return fn(db);
    });
  }

  /** Resolves an organization code to a tenant id before any tenant context exists (login). */
  async resolveTenant(orgCode: string): Promise<string | null> {
    return this.transaction(async (db) => {
      await db.query("SET LOCAL ROLE app_user");
      const { rows } = await db.query<{ id: string | null }>(
        "SELECT resolve_tenant_by_code($1) AS id",
        [orgCode],
      );
      return rows[0]?.id ?? null;
    });
  }

  private async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
