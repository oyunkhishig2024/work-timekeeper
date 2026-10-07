/** Attendance status of one employee on one work date (PRD 6, 6.6). */
export type AttendanceStatus =
  | "ON_TIME" // Цагтаа
  | "LATE" // Хоцорсон
  | "EXCUSED" // Шалтгаантай
  | "NO_SHOW" // Ирээгүй
  | "PENDING" // Хүлээгдэж байна (before the no-show cut-off)
  | "NOT_EXPECTED"
  | "WORKED_OFF_DAY"; // Ажилласан (амралтын өдөр)

/** Raw geofence transition reported by a device, already time-corrected by the server. */
export interface GeofenceEvent {
  type: "ENTER" | "EXIT";
  at: Date;
}
