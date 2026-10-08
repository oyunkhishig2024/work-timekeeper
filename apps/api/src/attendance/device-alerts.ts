import type { Db } from "../database/database.service";

export type DeviceAlertKind = "ATTESTATION_UNAVAILABLE_STREAK" | "DEVICE_CONFLICT";

/**
 * Opens an alert for HR unless the same one is already open (one per device, kind and counterpart). A conflict between two
 * employees is one alert, whichever of them triggered it. Returns true when a new alert was created.
 */
export async function raiseDeviceAlert(
  tx: Db,
  alert: {
    tenantId: string;
    kind: DeviceAlertKind;
    deviceId: string;
    employeeId: string;
    relatedEmployeeId?: string | null;
    detail?: string;
  },
): Promise<boolean> {
  if (alert.relatedEmployeeId) {
    const reverse = await tx.query(
      `SELECT 1 FROM device_alert
        WHERE kind = $1 AND employee_id = $2 AND related_employee_id = $3 AND resolved_at IS NULL`,
      [alert.kind, alert.relatedEmployeeId, alert.employeeId],
    );
    if (reverse.rows.length > 0) return false;
  }
  const res = await tx.query(
    `INSERT INTO device_alert (tenant_id, kind, device_id, employee_id, related_employee_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [
      alert.tenantId,
      alert.kind,
      alert.deviceId,
      alert.employeeId,
      alert.relatedEmployeeId ?? null,
      alert.detail ?? null,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}
