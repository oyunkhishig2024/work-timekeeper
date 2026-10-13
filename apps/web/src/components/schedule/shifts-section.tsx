"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import {
  createShiftAssignments,
  createShiftPattern,
  createShiftTemplate,
  deleteShiftAssignment,
  endShiftAssignment,
  fetchShiftAssignments,
  fetchShiftEmployees,
  fetchShiftPatterns,
  fetchShiftTemplates,
  newShiftTemplateVersion,
  patchShiftPattern,
  patchShiftTemplate,
  scheduleError,
  shiftTimes,
  type ShiftAssignment,
  type ShiftPattern,
  type ShiftTemplate,
} from "@/lib/schedule";
import { fieldClass, Modal, primaryButton, secondaryButton } from "../modal";

const message = (e: unknown) =>
  e instanceof ApiRequestError
    ? scheduleError(e.code, e.message)
    : "Холбогдож чадсангүй. Дахин оролдоно уу.";

/** Shift templates, rotation patterns (Org Admin) and who works which shift (HR, Org Admin) — PRD 23. */
export function ShiftsSection({
  isOrgAdmin,
  canAssign,
  today,
}: {
  isOrgAdmin: boolean;
  canAssign: boolean;
  today: string;
}) {
  const [templates, setTemplates] = useState<ShiftTemplate[] | null>(null);
  const [patterns, setPatterns] = useState<ShiftPattern[] | null>(null);
  const [assignments, setAssignments] = useState<ShiftAssignment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"template" | "pattern" | "assign" | ShiftTemplate | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const [t, p, a] = await Promise.all([
        fetchShiftTemplates(),
        fetchShiftPatterns(),
        fetchShiftAssignments(),
      ]);
      setTemplates(t);
      setPatterns(p);
      setAssignments(a);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(message(e));
    }
  }

  const names = new Map((templates ?? []).map((t) => [t.id, t.name]));
  const activeTemplates = (templates ?? []).filter((t) => t.active);

  return (
    <div className="space-y-10">
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {!templates || !patterns || !assignments ? (
        !error && <p className="text-slate-600">Ачаалж байна…</p>
      ) : (
        <>
          <section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Ээлжийн төрөл</h2>
              {isOrgAdmin && (
                <button
                  type="button"
                  className={primaryButton}
                  onClick={() => setDialog("template")}
                >
                  Ээлж нэмэх
                </button>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Жишээ: «Өдрийн ээлж 08:00–20:00». Ээлжээр ажилладаг ажилтныг Ажилтан хэсэгт «Ээлжээр»
              гэж тохируулсан байх ёстой.
            </p>
            {templates.length === 0 ? (
              <p className="mt-4 text-slate-600">Ээлж алга.</p>
            ) : (
              <ul className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
                {templates.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div>
                      <p className="font-medium">
                        {t.name}
                        {!t.active && <span className="ml-2 text-sm text-slate-500">(хаасан)</span>}
                      </p>
                      <p className="text-sm text-slate-600">
                        {shiftTimes(t)} · хоцролтын хүлцэл {t.graceMinutes} мин ·{" "}
                        {t.observesHolidays ? "баярын өдөр амарна" : "баярын өдөр ажиллана"}
                      </p>
                    </div>
                    {isOrgAdmin && (
                      <div className="flex flex-wrap gap-2">
                        {t.active && (
                          <button
                            type="button"
                            className={secondaryButton}
                            onClick={() => setDialog(t)}
                          >
                            Цаг өөрчлөх
                          </button>
                        )}
                        <button
                          type="button"
                          className={secondaryButton}
                          onClick={() =>
                            void run(() => patchShiftTemplate(t.id, { active: !t.active }))
                          }
                        >
                          {t.active ? "Хаах" : "Нээх"}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Ээлжийн мөчлөг</h2>
              {isOrgAdmin && (
                <button
                  type="button"
                  className={primaryButton}
                  disabled={activeTemplates.length === 0}
                  onClick={() => setDialog("pattern")}
                >
                  Мөчлөг нэмэх
                </button>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Өдөр бүр ямар ээлж эсвэл амралт болохыг дарааллаар нь тавина. Жишээ: өдөр, шөнө,
              амралт, амралт — дахин давтагдана.
            </p>
            {patterns.length === 0 ? (
              <p className="mt-4 text-slate-600">Мөчлөг алга.</p>
            ) : (
              <ul className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
                {patterns.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div>
                      <p className="font-medium">
                        {p.name}
                        {!p.active && <span className="ml-2 text-sm text-slate-500">(хаасан)</span>}
                      </p>
                      <p className="text-sm text-slate-600">
                        {p.cycleLengthDays} хоног:{" "}
                        {p.days.map((d) => (d ? (names.get(d) ?? "?") : "Амралт")).join(" → ")}
                      </p>
                    </div>
                    {isOrgAdmin && (
                      <button
                        type="button"
                        className={secondaryButton}
                        onClick={() =>
                          void run(() => patchShiftPattern(p.id, { active: !p.active }))
                        }
                      >
                        {p.active ? "Хаах" : "Нээх"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Хэн ямар ээлжтэй</h2>
              {canAssign && (
                <button
                  type="button"
                  className={primaryButton}
                  disabled={activeTemplates.length === 0}
                  onClick={() => setDialog("assign")}
                >
                  Ээлж оноох
                </button>
              )}
            </div>
            {assignments.length === 0 ? (
              <p className="mt-4 text-slate-600">Оноолт алга.</p>
            ) : (
              <ul className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
                {assignments.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div>
                      <p className="font-medium">
                        {a.employeeName}{" "}
                        <span className="text-sm text-slate-500">{a.employeeNo}</span>
                      </p>
                      <p className="text-sm text-slate-600">
                        {a.patternName ?? a.templateName} · {a.fromDate} →{" "}
                        {a.toDate ?? "тодорхойгүй"}
                      </p>
                    </div>
                    {canAssign && (
                      <div className="flex gap-2">
                        {a.fromDate > today ? (
                          <button
                            type="button"
                            className={secondaryButton}
                            onClick={() =>
                              window.confirm("Оноолтыг устгах уу?") &&
                              void run(() => deleteShiftAssignment(a.id))
                            }
                          >
                            Устгах
                          </button>
                        ) : (
                          (!a.toDate || a.toDate >= today) && (
                            <button
                              type="button"
                              className={secondaryButton}
                              onClick={() =>
                                window.confirm("Оноолтыг өнөөдрөөр дуусгах уу?") &&
                                void run(() => endShiftAssignment(a.id, today))
                              }
                            >
                              Өнөөдрөөр дуусгах
                            </button>
                          )
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      {dialog === "template" && (
        <TemplateDialog
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog && typeof dialog === "object" && (
        <TemplateDialog
          existing={dialog}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog === "pattern" && (
        <PatternDialog
          templates={activeTemplates}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog === "assign" && (
        <AssignDialog
          templates={activeTemplates}
          patterns={patterns?.filter((p) => p.active) ?? []}
          today={today}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function TemplateDialog({
  existing,
  onClose,
  onSaved,
}: {
  existing?: ShiftTemplate;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [start, setStart] = useState(existing?.startTime ?? "08:00");
  const [end, setEnd] = useState(existing?.endTime ?? "20:00");
  const [grace, setGrace] = useState(String(existing?.graceMinutes ?? 0));
  const [holidays, setHolidays] = useState(existing?.observesHolidays ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (start === end) return setError("Эхлэх, дуусах цаг ижил байж болохгүй.");
    setBusy(true);
    setError(null);
    const timing = {
      startTime: start,
      endTime: end,
      graceMinutes: Number(grace) || 0,
      observesHolidays: holidays,
    };
    try {
      if (existing) await newShiftTemplateVersion(existing.id, timing);
      else await createShiftTemplate({ name: name.trim(), ...timing });
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={existing ? `«${existing.name}» — цаг өөрчлөх` : "Ээлж нэмэх"} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4">
        {existing ? (
          <p className="text-sm text-slate-600">
            {existing.inUse
              ? "Энэ ээлж ашиглагдаж байгаа тул шинэ хувилбар үүснэ. Хуучин ээлж хаагдана, өмнөх өдрүүд өөрчлөгдөхгүй."
              : "Шинэ хувилбар үүснэ."}
          </p>
        ) : (
          <label className="block text-sm font-medium">
            Нэр
            <input
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={fieldClass}
            />
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium">
            Эхлэх цаг
            <input
              type="time"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            Дуусах цаг
            <input
              type="time"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className={fieldClass}
            />
          </label>
        </div>
        <p className="text-sm text-slate-600">
          Дуусах цаг эхлэхээс өмнө бол маргааш дуусна (шөнийн ээлж: 20:00 → 08:00).
        </p>
        <label className="block text-sm font-medium">
          Хоцролтын хүлцэл (минут)
          <input
            type="number"
            min={0}
            max={240}
            value={grace}
            onChange={(e) => setGrace(e.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={holidays}
            onChange={(e) => setHolidays(e.target.checked)}
          />
          Баярын өдөр амарна
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Болих
          </button>
          <button type="submit" className={primaryButton} disabled={busy}>
            Хадгалах
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PatternDialog({
  templates,
  onClose,
  onSaved,
}: {
  templates: ShiftTemplate[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [days, setDays] = useState<string[]>([templates[0]?.id ?? "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createShiftPattern({ name: name.trim(), days: days.map((d) => d || null) });
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Ээлжийн мөчлөг нэмэх" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4">
        <label className="block text-sm font-medium">
          Нэр
          <input
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
          />
        </label>
        <ol className="space-y-2">
          {days.map((d, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-16 text-sm">{i + 1}-р өдөр</span>
              <select
                aria-label={`${i + 1}-р өдөр`}
                value={d}
                onChange={(e) => setDays(days.map((x, j) => (j === i ? e.target.value : x)))}
                className={fieldClass}
              >
                <option value="">Амралт</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({shiftTimes(t)})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={secondaryButton}
                disabled={days.length <= 1}
                aria-label={`${i + 1}-р өдрийг хасах`}
                onClick={() => setDays(days.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
        <button type="button" className={secondaryButton} onClick={() => setDays([...days, ""])}>
          Өдөр нэмэх
        </button>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Болих
          </button>
          <button type="submit" className={primaryButton} disabled={busy || days.every((d) => !d)}>
            Хадгалах
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AssignDialog({
  templates,
  patterns,
  today,
  onClose,
  onSaved,
}: {
  templates: ShiftTemplate[];
  patterns: ShiftPattern[];
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [people, setPeople] = useState<Array<{
    id: string;
    fullName: string;
    employeeNo: string;
  }> | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [what, setWhat] = useState(
    patterns[0] ? `p:${patterns[0].id}` : `t:${templates[0]?.id ?? ""}`,
  );
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState("");
  const [cycleStart, setCycleStart] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchShiftEmployees()
      .then(setPeople)
      .catch((e: unknown) => setError(message(e)));
  }, []);

  const isPattern = what.startsWith("p:");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (chosen.size === 0) return setError("Ажилтан сонгоно уу.");
    setBusy(true);
    setError(null);
    try {
      await createShiftAssignments({
        employeeIds: [...chosen],
        patternId: isPattern ? what.slice(2) : null,
        templateId: isPattern ? null : what.slice(2),
        cycleStartDate: cycleStart || null,
        fromDate: from,
        toDate: to || null,
      });
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Ээлж оноох" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4">
        <fieldset>
          <legend className="text-sm font-medium">Ажилтнууд (ээлжээр ажилладаг)</legend>
          {people === null ? (
            <p className="mt-1 text-sm text-slate-600">Ачаалж байна…</p>
          ) : people.length === 0 ? (
            <p className="mt-1 text-sm text-slate-600">
              Ээлжээр ажиллах ажилтан алга. Ажилтны хэсэгт «Ээлжээр» гэж тохируулна уу.
            </p>
          ) : (
            <ul className="mt-1 max-h-48 overflow-auto rounded-md border border-slate-300 p-2">
              {people.map((p) => (
                <li key={p.id}>
                  <label className="flex min-h-9 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={chosen.has(p.id)}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(p.id);
                        else next.delete(p.id);
                        setChosen(next);
                      }}
                    />
                    {p.fullName} <span className="text-slate-500">{p.employeeNo}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <label className="block text-sm font-medium">
          Ээлж эсвэл мөчлөг
          <select value={what} onChange={(e) => setWhat(e.target.value)} className={fieldClass}>
            {patterns.map((p) => (
              <option key={p.id} value={`p:${p.id}`}>
                Мөчлөг: {p.name}
              </option>
            ))}
            {templates.map((t) => (
              <option key={t.id} value={`t:${t.id}`}>
                Ээлж: {t.name} ({shiftTimes(t)})
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium">
            Эхлэх огноо
            <input
              type="date"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            Дуусах огноо (заавал биш)
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={fieldClass}
            />
          </label>
        </div>
        {isPattern && (
          <label className="block text-sm font-medium">
            Мөчлөгийн 1-р өдөр (хоосон бол эхлэх огноо)
            <input
              type="date"
              value={cycleStart}
              onChange={(e) => setCycleStart(e.target.value)}
              className={fieldClass}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Болих
          </button>
          <button type="submit" className={primaryButton} disabled={busy}>
            Оноох
          </button>
        </div>
      </form>
    </Modal>
  );
}
