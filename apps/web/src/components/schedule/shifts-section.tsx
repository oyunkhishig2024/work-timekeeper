"use client";

import { useCallback, useEffect, useState } from "react";
import {
  deleteShiftAssignment,
  endShiftAssignment,
  fetchShiftAssignments,
  fetchShiftPatterns,
  fetchShiftTemplates,
  patchShiftPattern,
  patchShiftTemplate,
  shiftTimes,
  type ShiftAssignment,
  type ShiftPattern,
  type ShiftTemplate,
} from "@/lib/schedule";
import { primaryButton, secondaryButton } from "../styles";
import { message } from "./schedule-message";
import { FormError } from "@/components/form-error";
import dynamic from "next/dynamic";

const TemplateDialog = dynamic(() => import("./template-dialog").then((m) => m.TemplateDialog));
const PatternDialog = dynamic(() => import("./pattern-dialog").then((m) => m.PatternDialog));
const AssignDialog = dynamic(() => import("./assign-dialog").then((m) => m.AssignDialog));

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
      <FormError message={error} className="text-sm text-red-700" />
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
