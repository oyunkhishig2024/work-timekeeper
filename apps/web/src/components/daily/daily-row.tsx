"use client";

import { formatTime, STATUS_LABEL, type Status } from "@/lib/attendance";
import { departureText, offDayLabel, isReasonAssignable, type DailyItem } from "@/lib/daily";
import { STATUS_STYLE } from "../dashboard/status-ui";

export function Row({
  row: r,
  timeZone,
  canEdit,
  onAssign,
  onCorrect,
  ticked,
  onTick,
}: {
  row: DailyItem;
  timeZone: string;
  canEdit: boolean;
  onAssign: (r: DailyItem) => void;
  onCorrect: (r: DailyItem) => void;
  ticked: boolean;
  onTick: (r: DailyItem) => void;
}) {
  const expected = r.status !== "WORKED_OFF_DAY" && r.status !== "NOT_CONFIGURED";
  const label = expected
    ? STATUS_LABEL[r.status as Status]
    : r.status === "WORKED_OFF_DAY"
      ? offDayLabel(r.offDayKind)
      : "Тохиргоо дутуу";
  const lastSeen = formatTime(r.lastSeenAt, timeZone);
  return (
    <tr className={`border-t border-slate-100 align-top ${ticked ? "bg-teal-50" : ""}`}>
      {canEdit && (
        <td className="px-3 py-2">
          {isReasonAssignable(r) && (
            <input
              type="checkbox"
              aria-label={`${r.fullName} сонгох`}
              className="h-5 w-5"
              checked={ticked}
              onChange={() => onTick(r)}
            />
          )}
        </td>
      )}
      <td className="px-3 py-2">
        <div className="font-medium">{r.fullName}</div>
        <div className="text-xs text-slate-500">
          {[r.rank, r.position].filter(Boolean).join(" · ") || r.employeeNo}
        </div>
      </td>
      <td className="px-3 py-2">{r.departmentName ?? "—"}</td>
      <td className="px-3 py-2">{r.primaryLocationName ?? "—"}</td>
      <td className="px-3 py-2">
        {r.locationName ?? "—"}
        {r.temporary && (
          <span className="ml-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-900">
            Түр
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            expected ? STATUS_STYLE[r.status as Status].badge : "bg-slate-100 text-slate-800"
          }`}
        >
          {label}
        </span>
        {r.status === "WORKED_OFF_DAY" && (
          <div className="mt-1 text-xs text-slate-600">
            Ирсэн, гарсан цагийг тэмдэглэсэн · илүү цагт тооцоогүй, Хүний нөөц шийднэ
          </div>
        )}
        {r.source === "CORRECTED" && <div className="mt-1 text-xs text-slate-600">Засварласан</div>}
        {r.flaggedEvents > 0 && <div className="mt-1 text-xs text-slate-600">⚑ шалгах</div>}
        {r.locationInactive && (
          <div className="mt-1 text-xs text-orange-800">
            Байршил идэвхгүй · {lastSeen ? `сүүлд ${lastSeen}` : "утас холбогдоогүй"}
          </div>
        )}
      </td>
      <td className="px-3 py-2">{formatTime(r.arrivalAt, timeZone) ?? "—"}</td>
      <td className="px-3 py-2">
        {departureText(r, (iso) => formatTime(iso, timeZone))}
        {r.earlyLeaveMinutes > 0 && (
          <div className="mt-1 text-xs font-medium text-orange-800">
            Эрт гарсан · {r.earlyLeaveMinutes} мин
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        {r.status === "LATE" && r.lateMinutes > 0 ? `${r.lateMinutes} мин` : "—"}
      </td>
      <td className="px-3 py-2">
        {r.reasonName ? (
          <>
            {r.reasonName}
            {r.reasonNote && <div className="text-xs text-slate-600">{r.reasonNote}</div>}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2">
        {canEdit && expected && (
          <div className="flex flex-wrap gap-1">
            {!r.reasonName && (
              <button
                type="button"
                className="min-h-11 rounded-md border border-slate-300 px-3 hover:bg-slate-100"
                onClick={() => onAssign(r)}
              >
                Шалтгаан
              </button>
            )}
            <button
              type="button"
              className="min-h-11 rounded-md border border-slate-300 px-3 hover:bg-slate-100"
              onClick={() => onCorrect(r)}
            >
              Засах
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
