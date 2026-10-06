import { randomUUID } from "node:crypto";
import { Client } from "pg";

export const hasDb = Boolean(process.env.TEST_DATABASE_URL);

/** Connection as the migration owner (a superuser locally), used to seed fixtures. */
export async function connectOwner(): Promise<Client> {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  return client;
}

/**
 * Runs `fn` inside a transaction as the runtime role (`app_user`) with the tenant set, exactly as
 * the API will for every request. Always rolled back so tests leave no data behind.
 */
export async function asTenant<T>(
  client: Client,
  tenantId: string | null,
  fn: () => Promise<T>,
  role: "app_user" | "platform_admin" = "app_user",
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    return await fn();
  } finally {
    await client.query("ROLLBACK");
  }
}

export interface Fixture {
  tenantId: string;
  departmentId: string;
  locationId: string;
  employeeId: string;
}

/** Creates a tenant with one department, one location and one employee (as the owner). */
export async function createFixture(
  client: Client,
  code = `t-${randomUUID().slice(0, 8)}`,
): Promise<Fixture> {
  const tenant = await client.query<{ id: string }>(
    "INSERT INTO tenant (code, name) VALUES ($1, $1) RETURNING id",
    [code],
  );
  const tenantId = tenant.rows[0]!.id;
  const dept = await client.query<{ id: string }>(
    "INSERT INTO department (tenant_id, name) VALUES ($1, 'Хүний нөөц') RETURNING id",
    [tenantId],
  );
  const loc = await client.query<{ id: string }>(
    "INSERT INTO location (tenant_id, name, lat, lng, radius_m) VALUES ($1, 'Төв салбар', 47.9, 106.9, 150) RETURNING id",
    [tenantId],
  );
  const emp = await client.query<{ id: string }>(
    `INSERT INTO employee (tenant_id, employee_no, full_name, department_id, primary_location_id)
     VALUES ($1, 'E-001', 'Бадам Гэндэн', $2, $3) RETURNING id`,
    [tenantId, dept.rows[0]!.id, loc.rows[0]!.id],
  );
  return {
    tenantId,
    departmentId: dept.rows[0]!.id,
    locationId: loc.rows[0]!.id,
    employeeId: emp.rows[0]!.id,
  };
}
