"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { fetchOrganization, type Organization } from "@/lib/attendance";
import { fetchDepartments, fetchLocations, type Option } from "@/lib/daily";
import {
  CONSENT_LABEL,
  DEVICE_STATUS_LABEL,
  DISABLE_REASON_LABEL,
  fetchConsent,
  fetchDevices,
  fetchEmployee,
  fetchHistory,
  fetchTitles,
  formFrom,
  patchBody,
  STATUS_LABEL,
  type ConsentInfo,
  type DeviceRow,
  type EmployeeDetail,
  type HistoryRow,
} from "@/lib/employees";
import type { SessionUser } from "@/lib/session";
import { fieldClass, Modal, primaryButton, secondaryButton } from "../modal";
import { NoteDialog } from "../review/note-dialog";
import { EmployeeFormDialog } from "./employee-form";
import { ReplacementQrDialog } from "./qr-dialog";

function errorText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : "Алдаа гарлаа. Дахин оролдоно уу.";
}

function Card({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      <div className="mt-2 text-sm">{children}</div>
    </section>
  );
}

const small =
  "min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-100 disabled:opacity-60";

/** One employee (PRD 12): details, rank and position histories, login, devices and QR, consent, lifecycle. */
export function EmployeeDetailScreen({ user }: { user: SessionUser }) {
  const { id } = useParams<{ id: string }>();
  const canEdit = user.role === "ORG_ADMIN" || user.role === "HR";
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [consent, setConsent] = useState<ConsentInfo | null>(null);
  const [ranks, setRanks] = useState<HistoryRow[]>([]);
  const [positions, setPositions] = useState<HistoryRow[]>([]);
  const [org, setOrg] = useState<Organization | null>(null);
  const [departments, setDepartments] = useState<Option[]>([]);
  const [locations, setLocations] = useState<Option[]>([]);
  const [rankSuggestions, setRankSuggestions] = useState<string[]>([]);
  const [positionSuggestions, setPositionSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    "edit" | "rank" | "position" | "disable" | "reactivate" | "qr" | "device" | "password" | null
  >(null);
  const [password, setPassword] = useState<{ username: string; temporaryPassword: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const e = await fetchEmployee(id);
      setEmployee(e);
      setError(null);
      if (canEdit) {
        const [d, c, r, p] = await Promise.all([
          fetchDevices(id).catch(() => []),
          fetchConsent(id).catch(() => null),
          fetchHistory(id, "rank").catch(() => []),
          fetchHistory(id, "position").catch(() => []),
        ]);
        setDevices(d);
        setConsent(c);
        setRanks(r);
        setPositions(p);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }, [id, canEdit]);

  useEffect(() => {
    void load();
    fetchOrganization().then(setOrg, () => undefined);
    fetchDepartments().then(setDepartments, () => undefined);
    fetchLocations().then(setLocations, () => undefined);
    if (canEdit) {
      fetchTitles("rank").then(setRankSuggestions, () => undefined);
      fetchTitles("position").then(setPositionSuggestions, () => undefined);
    }
  }, [load, canEdit]);

  // Reload first, then close: the page behind the dialog already shows the change when it disappears.
  const done = async (text: string) => {
    await load();
    setDialog(null);
    setMessage(text);
  };

  if (error && !employee) {
    return (
      <div>
        <Link href="/employees" className="text-teal-700 underline">
          ← Ажилтнууд
        </Link>
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      </div>
    );
  }
  if (!employee) return <p className="text-slate-600">Ачаалж байна…</p>;
  const active = employee.status === "ACTIVE";
  const activeDevice = devices.find((d) => d.status === "ACTIVE");

  return (
    <div>
      <Link href="/employees" className="inline-flex min-h-11 items-center text-teal-700 underline">
        ← Ажилтнууд
      </Link>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{employee.fullName}</h1>
        <p className="text-sm text-slate-600">
          <span className="font-mono">{employee.employeeNo}</span> · {STATUS_LABEL[employee.status]}
        </p>
      </div>
      {(error || message) && (
        <p
          role={error ? "alert" : "status"}
          className={`mt-3 rounded-md p-3 text-sm ${error ? "bg-red-50 text-red-800" : "bg-teal-50 text-teal-900"}`}
        >
          {error ?? message}
        </p>
      )}

      <div className="mt-4 space-y-4">
        <Card
          title="Үндсэн мэдээлэл"
          action={
            canEdit && employee.status !== "ARCHIVED" ? (
              <button type="button" className={small} onClick={() => setDialog("edit")}>
                Засах
              </button>
            ) : null
          }
        >
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {(
              [
                ["Цол", employee.rank ?? "—"],
                ["Албан тушаал", employee.position ?? "—"],
                ["Нэгж", employee.departmentName],
                ["Үндсэн салбар", employee.locationName],
                ["Ажилд орсон", employee.startDate ?? "—"],
                ["Ажлаас гарсан", employee.endDate ?? "—"],
                ["Хуваарь", employee.scheduleMode === "SHIFT" ? "Ээлжийн" : "Энгийн"],
                ["Ирц бүртгэх", employee.manualAttendance ? "Гараар" : "Утсаар"],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex gap-2">
                <dt className="w-32 shrink-0 text-slate-500">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </Card>

        {canEdit && (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <Card
                title="Цолны түүх"
                action={
                  active && (
                    <button type="button" className={small} onClick={() => setDialog("rank")}>
                      Цол өөрчлөх
                    </button>
                  )
                }
              >
                <History rows={ranks} field="rank" />
              </Card>
              <Card
                title="Албан тушаалын түүх"
                action={
                  active && (
                    <button type="button" className={small} onClick={() => setDialog("position")}>
                      Албан тушаал өөрчлөх
                    </button>
                  )
                }
              >
                <History rows={positions} field="position" />
              </Card>
            </div>

            <Card
              title="Утас ба нэвтрэх эрх"
              action={
                active && (
                  <button type="button" className={small} onClick={() => setDialog("qr")}>
                    Утас солих QR
                  </button>
                )
              }
            >
              <p>
                Нэвтрэх эрх:{" "}
                {employee.account ? (
                  <>
                    <b>{employee.account.username}</b> (
                    {employee.account.status === "ACTIVE" ? "идэвхтэй" : employee.account.status})
                  </>
                ) : active ? (
                  <button
                    type="button"
                    className={small}
                    onClick={() =>
                      void api<{ username: string; temporaryPassword: string }>(
                        `/v1/employees/${id}/account`,
                        { method: "POST", body: {} },
                      ).then(
                        (r) => {
                          setPassword(r);
                          setDialog("password");
                          void load();
                        },
                        (e) => setError(errorText(e)),
                      )
                    }
                  >
                    Нэвтрэх эрх үүсгэх
                  </button>
                ) : (
                  "байхгүй"
                )}
              </p>
              <h3 className="mt-3 font-medium">Төхөөрөмжийн түүх</h3>
              {devices.length === 0 ? (
                <p className="text-slate-600">Утас бүртгэгдээгүй байна.</p>
              ) : (
                <ul className="mt-1 divide-y divide-slate-100">
                  {devices.map((d) => (
                    <li
                      key={d.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span>
                        {d.platform === "IOS" ? "iPhone" : "Android"}
                        {d.model ? ` · ${d.model}` : ""} ·{" "}
                        {new Date(d.registeredAt).toLocaleDateString("sv-SE")}
                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs">
                          {DEVICE_STATUS_LABEL[d.status]}
                        </span>
                        {d.disabledReason ? (
                          <span className="ml-2 text-xs text-slate-600">
                            {DISABLE_REASON_LABEL[d.disabledReason] ?? d.disabledReason}
                          </span>
                        ) : null}
                      </span>
                      {d.status === "ACTIVE" && (
                        <button type="button" className={small} onClick={() => setDialog("device")}>
                          Идэвхгүй болгох
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Зөвшөөрлийн хуудас">
              {consent ? (
                <>
                  <p>
                    Төлөв: <b>{CONSENT_LABEL[consent.status]}</b>
                    {consent.reconsentRequired ? " · шинэ хувилбар дээр дахин зөвшөөрөл авна" : ""}
                  </p>
                  {consent.records.length > 0 && (
                    <ul className="mt-1 text-slate-700">
                      {consent.records.map((r) => (
                        <li key={r.id}>
                          <span className="font-mono text-xs">{r.formCode}</span> · {r.status}
                          {r.signedOn ? ` · ${r.signedOn}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="text-slate-600">Мэдээлэл алга.</p>
              )}
            </Card>

            <Card title="Ажилтны төлөв">
              {active ? (
                <button type="button" className={small} onClick={() => setDialog("disable")}>
                  Идэвхгүй болгох (ажлаас гарсан)
                </button>
              ) : employee.status === "DISABLED" ? (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={small} onClick={() => setDialog("reactivate")}>
                    Дахин идэвхжүүлэх
                  </button>
                  <button
                    type="button"
                    className={small}
                    onClick={() =>
                      void api(`/v1/employees/${id}/archive`, {
                        method: "POST",
                        body: user.role === "ORG_ADMIN" ? {} : {},
                      }).then(
                        () => done("Архивлалаа."),
                        (e) => setError(errorText(e)),
                      )
                    }
                  >
                    Архивлах
                  </button>
                </div>
              ) : (
                <p className="text-slate-600">Архивласан бүртгэл зөвхөн унших.</p>
              )}
              <p className="mt-2 text-xs text-slate-500">
                Идэвхгүй болгоход нэвтрэх эрх, утас хаагдана; түүх хадгалагдана. Ажилтныг устгах
                боломжгүй.
              </p>
            </Card>
          </>
        )}
      </div>

      {dialog === "edit" && (
        <EmployeeFormDialog
          title="Ажилтны мэдээлэл засах"
          initial={formFrom(employee)}
          departments={departments}
          locations={locations}
          rankSuggestions={rankSuggestions}
          positionSuggestions={positionSuggestions}
          submitLabel="Хадгалах"
          onClose={() => setDialog(null)}
          onSubmit={async (form) => {
            const body = patchBody(employee, form);
            if (Object.keys(body).length === 0) return setDialog(null);
            await api(`/v1/employees/${id}`, { method: "PATCH", body });
            await done("Хадгаллаа.");
          }}
        />
      )}
      {org && (dialog === "rank" || dialog === "position") && (
        <TitleDialog
          today={org.today}
          kind={dialog}
          current={dialog === "rank" ? employee.rank : employee.position}
          suggestions={dialog === "rank" ? rankSuggestions : positionSuggestions}
          startDate={employee.startDate}
          onClose={() => setDialog(null)}
          onSaved={() => done("Түүхэнд бүртгэлээ.")}
          employeeId={id}
        />
      )}
      {org && dialog === "disable" && (
        <DisableDialog
          today={org.today}
          employeeId={id}
          startDate={employee.startDate}
          onClose={() => setDialog(null)}
          onSaved={() => done("Идэвхгүй болголоо.")}
        />
      )}
      {org && dialog === "reactivate" && (
        <ReactivateDialog
          today={org.today}
          employee={employee}
          departments={departments}
          locations={locations}
          onClose={() => setDialog(null)}
          onSaved={(pw) => {
            setPassword(pw);
            setDialog(pw ? "password" : null);
            setMessage("Дахин идэвхжүүллээ. Утсаа дахин бүртгүүлнэ.");
            void load();
          }}
        />
      )}
      {dialog === "qr" && (
        <ReplacementQrDialog
          employeeId={id}
          fullName={employee.fullName}
          canOverride={user.role === "ORG_ADMIN"}
          onClose={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog === "device" && activeDevice && (
        <DeviceDialog
          deviceId={activeDevice.id}
          onClose={() => setDialog(null)}
          onSaved={() => done("Төхөөрөмжийг идэвхгүй болголоо.")}
        />
      )}
      {dialog === "password" && password && (
        <Modal title="Нэг удаагийн нууц үг" onClose={() => setDialog(null)}>
          <p className="mt-2 text-sm text-slate-700">
            Нэвтрэх нэр: <b>{password.username}</b>
          </p>
          <p className="mt-2 rounded-md bg-slate-100 p-3 text-center font-mono text-lg">
            {password.temporaryPassword}
          </p>
          <p className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900">
            Нууц үгийг дахин харах боломжгүй. Ажилтанд өгнө үү; эхний нэвтрэлтээр солино.
          </p>
          <div className="mt-3 flex justify-end">
            <button type="button" className={primaryButton} onClick={() => setDialog(null)}>
              Хаах
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function History({ rows, field }: { rows: HistoryRow[]; field: "rank" | "position" }) {
  if (rows.length === 0) return <p className="text-slate-600">Бүртгэл байхгүй.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => (
        <li key={r.id} className="py-1.5">
          <b>{r[field]}</b>
          <span className="text-slate-600">
            {" "}
            · {r.validFrom} → {r.validTo ?? "одоог хүртэл"}
          </span>
          {r.note && <div className="text-xs text-slate-600">{r.note}</div>}
        </li>
      ))}
    </ul>
  );
}

function TitleDialog({
  today,
  kind,
  current,
  suggestions,
  startDate,
  employeeId,
  onClose,
  onSaved,
}: {
  /** The organization's date, not the browser's: the server rejects a date that is still in the future for it. */
  today: string;
  kind: "rank" | "position";
  current: string | null;
  suggestions: string[];
  startDate: string | null;
  employeeId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = kind === "rank" ? "Шинэ цол" : "Шинэ албан тушаал";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return setError(`${label} бичнэ үү.`);
    if (date > today) return setError("Ирээдүйн огноо оруулж болохгүй.");
    if (startDate && date < startDate) return setError("Ажилд орсон огнооноос өмнө байж болохгүй.");
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/employees/${employeeId}/${kind}`, {
        method: "PUT",
        body: {
          [kind]: value.trim(),
          effectiveDate: date,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Modal title={kind === "rank" ? "Цол өөрчлөх" : "Албан тушаал өөрчлөх"} onClose={onClose}>
      <p className="mt-1 text-sm text-slate-700">
        Одоогийн: {current ?? "—"}. Нөгөөг нь хөндөхгүй, түүхэнд тусад нь хадгална. Өнөөдөр
        бүртгэсэн утгыг «Засах»-аар засна.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <label className="block text-sm font-medium">
          {label}
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            list={`${kind}-list`}
            maxLength={120}
            className={fieldClass}
          />
          <datalist id={`${kind}-list`}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="block text-sm font-medium">
          Хүчинтэй болох огноо
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          Тэмдэглэл (тушаалын дугаар гэх мэт, заавал биш)
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            className={fieldClass}
          />
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
          <button type="submit" disabled={busy} className={primaryButton}>
            Хадгалах
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DisableDialog({
  today,
  employeeId,
  startDate,
  onClose,
  onSaved,
}: {
  today: string;
  employeeId: string;
  startDate: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(today);
  return (
    <NoteDialog
      title="Ажилтныг идэвхгүй болгох"
      intro={`Хүчинтэй болох огноо: ${date}. Нэвтрэх эрх, утас хаагдаж, хойшлох шалтгаан, түр томилолт цуцлагдана.`}
      label="Шалтгаан"
      required={false}
      submitLabel="Идэвхгүй болгох"
      validate={() =>
        date > today
          ? "Ирээдүйн огноо оруулж болохгүй."
          : startDate && date < startDate
            ? "Ажилд орсон огнооноос өмнө байж болохгүй."
            : null
      }
      onSubmit={async (note) => {
        try {
          await api(`/v1/employees/${employeeId}/disable`, {
            method: "POST",
            body: { effectiveDate: date, ...(note.trim() ? { reason: note.trim() } : {}) },
          });
        } catch (e) {
          throw new Error(errorText(e));
        }
        onSaved();
      }}
      onClose={onClose}
      extra={
        <label className="block text-sm font-medium">
          Огноо
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            className={fieldClass}
          />
        </label>
      }
    />
  );
}

function ReactivateDialog({
  today,
  employee,
  departments,
  locations,
  onClose,
  onSaved,
}: {
  today: string;
  employee: EmployeeDetail;
  departments: Option[];
  locations: Option[];
  onClose: () => void;
  onSaved: (password: { username: string; temporaryPassword: string } | null) => void;
}) {
  const [departmentId, setDepartmentId] = useState(employee.departmentId);
  const [locationId, setLocationId] = useState(employee.primaryLocationId);
  const [startDate, setStartDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // An employee who has a login gets a new one-time password with the reactivation (PRD 12.2).
      const res = await api<{ temporaryPassword?: string }>(
        `/v1/employees/${employee.id}/reactivate`,
        {
          method: "POST",
          body: { departmentId, primaryLocationId: locationId, startDate },
        },
      );
      const pw =
        res.temporaryPassword && employee.account
          ? { username: employee.account.username, temporaryPassword: res.temporaryPassword }
          : null;
      onSaved(pw);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Modal title="Дахин идэвхжүүлэх" onClose={onClose}>
      <p className="mt-1 text-sm text-slate-700">
        Нэгж, салбараа дахин баталгаажуулна. Хуучин утас хаалттай хэвээр, шинэ QR хэрэгтэй.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <label className="block text-sm font-medium">
          Нэгж
          <select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            className={fieldClass}
          >
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Үндсэн салбар
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className={fieldClass}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Ажилд орсон огноо
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className={fieldClass}
          />
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
          <button type="submit" disabled={busy} className={primaryButton}>
            Идэвхжүүлэх
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeviceDialog({
  deviceId,
  onClose,
  onSaved,
}: {
  deviceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState<"LOST" | "STOLEN" | "OTHER">("LOST");
  return (
    <NoteDialog
      title="Төхөөрөмжийг идэвхгүй болгох"
      intro="Утас дараа нь ирц хүлээн авахаа болино, нэвтрэлт нь тасарна. Шинэ утсанд QR хэрэгтэй."
      label="Тэмдэглэл"
      required={false}
      submitLabel="Идэвхгүй болгох"
      onSubmit={async (note) => {
        try {
          await api(`/v1/devices/${deviceId}/disable`, {
            method: "POST",
            body: { reason, ...(note.trim() ? { note: note.trim() } : {}) },
          });
        } catch (e) {
          throw new Error(errorText(e));
        }
        onSaved();
      }}
      onClose={onClose}
      extra={
        <label className="block text-sm font-medium">
          Шалтгаан
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as typeof reason)}
            className={fieldClass}
          >
            <option value="LOST">Алдсан</option>
            <option value="STOLEN">Хулгайд алдсан</option>
            <option value="OTHER">Бусад</option>
          </select>
        </label>
      }
    />
  );
}
