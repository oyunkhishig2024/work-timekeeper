/** Attendance status of one employee on one work date (PRD 6, 6.6). */
export type AttendanceStatus =
  | "ON_TIME" // Цагтаа
  | "LATE" // Хоцорсон
  | "EXCUSED" // Шалтгаантай
  | "NO_SHOW" // Ирээгүй
  | "PENDING" // Хүлээгдэж байна (before the no-show cut-off)
  | "NOT_EXPECTED"
  | "WORKED_OFF_DAY"; // Ажилласан (амралтын өдөр)

/** Result of resolving "who must attend, where and when" for one work date (PRD 6.1, 23.5). */
export type Expectation =
  | { expected: false; reason: "INACTIVE" | "HOLIDAY" | "OFF_DAY" | "SHIFT_OFF" }
  | {
      expected: true;
      /** YYYY-MM-DD, the date the shift/day starts, in the location time zone. */
      workDate: string;
      locationId: string;
      shiftTemplateId?: string;
      start: Date;
      end: Date;
      graceMinutes: number;
      cutoff: Date;
      earlyWindowStart: Date;
    };

/** Raw geofence transition reported by a device, already time-corrected by the server. */
export interface GeofenceEvent {
  type: "ENTER" | "EXIT";
  at: Date;
}
