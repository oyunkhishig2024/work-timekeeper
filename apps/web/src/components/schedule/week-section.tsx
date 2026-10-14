"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import type { Option } from "@/lib/daily";
import {
  DEFAULT_END,
  DEFAULT_START,
  fetchRules,
  fetchWorkingWeek,
  inheritWorkingWeek,
  putRules,
  putWorkingWeek,
  timesInOrder,
  upcomingStart,
  WEEKDAYS,
  type Rules,
  type WeekDay,
  type WorkingWeek,
} from "@/lib/schedule";
import { compactField, fieldClass, primaryButton, secondaryButton } from "../styles";
import { message } from "./schedule-message";
import { FormError } from "@/components/form-error";

const nextDay = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** The working week (PRD 14.1) and the attendance rules (PRD 6.2–6.4, 23.2): organization-wide, or one branch's own. */
export function WeekSection({
  canEdit,
  today,
  locations,
}: {
  canEdit: boolean;
  today: string;
  locations: Option[];
}) {
  const [locationId, setLocationId] = useState<string>("");
  const [week, setWeek] = useState<WorkingWeek | null | undefined>(undefined);
  const [rules, setRules] = useState<Rules | null>(null);
  const [days, setDays] = useState<WeekDay[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nextWeek, setNextWeek] = useState<string | null>(null);
  const [nextRules, setNextRules] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const id = locationId || null;
    try {
      const w = await fetchWorkingWeek(id).catch((e: unknown) => {
        if (e instanceof ApiRequestError && e.code === "WORKING_WEEK_NOT_CONFIGURED") return null;
        throw e;
      });
      setWeek(w);
      setDays(
        w
          ? w.days
          : WEEKDAYS.map((_, i) => ({
              weekday: i + 1,
              working: i < 5,
              start: i < 5 ? DEFAULT_START : null,
              end: i < 5 ? DEFAULT_END : null,
            })),
      );
      setRules(await fetchRules(id));
      setNextWeek(await upcomingStart("working-week", id, today));
      setNextRules(await upcomingStart("attendance-rules", id, today));
    } catch (e) {
      setError(message(e));
    }
  }, [locationId, today]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-8">
      <label className="block max-w-sm text-sm font-medium">
        Хаана хамаарах
        <select
          className={fieldClass}
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          <option value="">Бүх байгууллага (үндсэн хуваарь)</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} салбарын өөрийн хуваарь
            </option>
          ))}
        </select>
      </label>
      <FormError message={error} className="text-sm text-red-700" />
      <WeekEditor
        key={`${locationId}-${week?.id ?? "none"}`}
        canEdit={canEdit}
        today={today}
        locationId={locationId || null}
        week={week}
        planned={nextWeek}
        days={days}
        setDays={setDays}
        onSaved={load}
      />
      {rules && (
        <RulesEditor
          key={`${locationId}-${rules.id ?? "default"}`}
          canEdit={canEdit}
          today={today}
          locationId={locationId || null}
          rules={rules}
          planned={nextRules}
          onSaved={load}
        />
      )}
    </div>
  );
}

function WeekEditor({
  canEdit,
  today,
  locationId,
  week,
  planned,
  days,
  setDays,
  onSaved,
}: {
  canEdit: boolean;
  today: string;
  locationId: string | null;
  week: WorkingWeek | null | undefined;
  planned: string | null;
  days: WeekDay[];
  setDays: (d: WeekDay[]) => void;
  onSaved: () => Promise<void>;
}) {
  const [from, setFrom] = useState(nextDay(today));
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const change = (weekday: number, patch: Partial<WeekDay>) =>
    setDays(days.map((d) => (d.weekday === weekday ? { ...d, ...patch } : d)));
  const invalid = days.some((d) => d.working && !timesInOrder(d.start, d.end));

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await putWorkingWeek({ locationId, effectiveFrom: from, days });
      setOk(`Хадгалагдлаа. ${from}-ээс эхлэн хүчинтэй.`);
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function useDefault() {
    if (!locationId) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await inheritWorkingWeek(locationId, from);
      setOk(`Байгууллагын үндсэн хуваарийг ${from}-ээс эхлэн ашиглана.`);
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void save(e)}
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-lg font-semibold">Ажлын долоо хоног</h2>
      <p className="mt-1 text-sm text-slate-600">
        {week === null
          ? "Хуваарь тохируулаагүй байна: хадгалах хүртэл хэн ч ажиллах ёстой гэж тооцогдохгүй."
          : week
            ? `Одоо хүчинтэй: ${week.validFrom}-ээс${week.inherited ? " (байгууллагын үндсэн хуваарь)" : ""}.`
            : "Ачаалж байна…"}
      </p>
      {planned && (
        <p className="mt-1 text-sm font-medium text-amber-800">
          Төлөвлөсөн өөрчлөлт {planned}-ээс эхэлнэ (хадгалсан). Доорх хүснэгт одоо хүчинтэйг харуулж
          байна; дахин хадгалбал төлөвлөсөн өөрчлөлтийг солино.
        </p>
      )}
      <ul className="mt-4 divide-y divide-slate-100">
        {days.map((d) => (
          <li key={d.weekday} className="flex flex-wrap items-center gap-3 py-2">
            <label className="flex w-40 items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={d.working}
                onChange={(e) =>
                  change(
                    d.weekday,
                    e.target.checked
                      ? { working: true, start: DEFAULT_START, end: DEFAULT_END }
                      : { working: false, start: null, end: null },
                  )
                }
              />
              {WEEKDAYS[d.weekday - 1]}
            </label>
            {d.working ? (
              <span className="flex items-center gap-2 text-sm">
                <input
                  type="time"
                  aria-label={`${WEEKDAYS[d.weekday - 1]} эхлэх цаг`}
                  disabled={!canEdit}
                  value={d.start ?? ""}
                  onChange={(e) => change(d.weekday, { start: e.target.value })}
                  className={compactField}
                />
                –
                <input
                  type="time"
                  aria-label={`${WEEKDAYS[d.weekday - 1]} дуусах цаг`}
                  disabled={!canEdit}
                  value={d.end ?? ""}
                  onChange={(e) => change(d.weekday, { end: e.target.value })}
                  className={compactField}
                />
              </span>
            ) : (
              <span className="text-sm text-slate-500">Амралт</span>
            )}
          </li>
        ))}
      </ul>
      {invalid && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          Эхлэх цаг дуусах цагаас өмнө байх ёстой.
        </p>
      )}
      {canEdit && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium">
            Хүчинтэй болох огноо
            <input
              type="date"
              required
              min={today}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={fieldClass}
            />
          </label>
          <button
            type="submit"
            disabled={busy || invalid || days.length !== 7}
            className={primaryButton}
          >
            Хадгалах
          </button>
          {locationId && (
            <button
              type="button"
              disabled={busy}
              className={secondaryButton}
              onClick={() => void useDefault()}
            >
              Үндсэн хуваарь ашиглах
            </button>
          )}
        </div>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Өөрчлөлт сонгосон өдрөөс хойш хүчинтэй. Өнгөрсөн өдрийн ирц өөрчлөгдөхгүй.
      </p>
      <FormError message={error} className="mt-2 text-sm text-red-700" />
      {ok && (
        <p role="status" className="mt-2 text-sm text-teal-800">
          {ok}
        </p>
      )}
    </form>
  );
}

function RulesEditor({
  canEdit,
  today,
  locationId,
  rules,
  planned,
  onSaved,
}: {
  canEdit: boolean;
  today: string;
  locationId: string | null;
  rules: Rules;
  planned: string | null;
  onSaved: () => Promise<void>;
}) {
  const [grace, setGrace] = useState(String(rules.graceMinutes));
  const [stay, setStay] = useState(String(rules.minStayMinutes));
  const [early, setEarly] = useState(String(rules.earlyLeaveToleranceMinutes));
  const [from, setFrom] = useState(nextDay(today));
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await putRules({
        locationId,
        effectiveFrom: from,
        graceMinutes: Number(grace),
        minStayMinutes: Number(stay),
        earlyLeaveToleranceMinutes: Number(early),
      });
      setOk(`Хадгалагдлаа. ${from}-ээс эхлэн хүчинтэй.`);
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const num = (
    label: string,
    help: string,
    value: string,
    set: (v: string) => void,
    min: number,
    max: number,
  ) => (
    <label className="block text-sm font-medium">
      {label}
      <input
        type="number"
        required
        min={min}
        max={max}
        disabled={!canEdit}
        value={value}
        onChange={(e) => set(e.target.value)}
        className={fieldClass}
      />
      <span className="mt-1 block text-xs font-normal text-slate-500">{help}</span>
    </label>
  );

  return (
    <form
      onSubmit={(e) => void save(e)}
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-lg font-semibold">Ирцийн дүрэм</h2>
      <p className="mt-1 text-sm text-slate-600">
        {rules.source === "DEFAULT"
          ? "Одоо анхны утга ашиглаж байна (хадгалаагүй)."
          : rules.source === "LOCATION"
            ? `Энэ салбарын өөрийн дүрэм, ${rules.validFrom}-ээс.`
            : `Байгууллагын дүрэм, ${rules.validFrom}-ээс.`}
      </p>
      {planned && (
        <p className="mt-1 text-sm font-medium text-amber-800">
          Төлөвлөсөн өөрчлөлт {planned}-ээс эхэлнэ (хадгалсан). Дахин хадгалбал солино.
        </p>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {num(
          "Хоцролтын зөвшөөрөл, минут",
          "Ажил эхэлснээс хойш энэ хугацаанд ирвэл «Цагтаа».",
          grace,
          setGrace,
          0,
          240,
        )}
        {num(
          "Хамгийн бага байх хугацаа, минут",
          "Ажлын байрны орчимд энэ хугацаанаас богино хугацаанд байвал ирсэнд тооцохгүй.",
          stay,
          setStay,
          1,
          15,
        )}
        {num(
          "Эрт гарсныг тооцох, минут",
          "Ажил тарахаас энэ хугацаанаас илүү өмнө гарвал «Эрт гарсан».",
          early,
          setEarly,
          0,
          240,
        )}
      </div>
      {canEdit && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium">
            Хүчинтэй болох огноо
            <input
              type="date"
              required
              min={today}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={fieldClass}
            />
          </label>
          <button type="submit" disabled={busy} className={primaryButton}>
            Хадгалах
          </button>
        </div>
      )}
      <FormError message={error} className="mt-2 text-sm text-red-700" />
      {ok && (
        <p role="status" className="mt-2 text-sm text-teal-800">
          {ok}
        </p>
      )}
    </form>
  );
}
