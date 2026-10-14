"use client";

import { OneTimePasswordDialog } from "../one-time-password";
import { actionErrorText } from "@/components/api-error";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
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
import { smallButton } from "../styles";
import { Card, History } from "./detail-parts";
import dynamic from "next/dynamic";

const ReplacementQrDialog = dynamic(() => import("./qr-dialog").then((m) => m.ReplacementQrDialog));
const TitleDialog = dynamic(() => import("./title-dialog").then((m) => m.TitleDialog));
const DisableDialog = dynamic(() => import("./lifecycle-dialogs").then((m) => m.DisableDialog));
const ReactivateDialog = dynamic(() =>
  import("./lifecycle-dialogs").then((m) => m.ReactivateDialog),
);
const DeviceDialog = dynamic(() => import("./device-dialog").then((m) => m.DeviceDialog));
const EmployeeFormDialog = dynamic(() =>
  import("./employee-form").then((m) => m.EmployeeFormDialog),
);

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
      setError(actionErrorText(e));
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

  /** Forgotten password: a new one-time password, shown once; the old one stops working and every session of the person ends. */
  async function resetPassword(account: { userId: string; username: string }) {
    const ok = window.confirm(
      `«${account.username}» нууц үгийг сэргээх үү? Хуучин нууц үг хүчингүй болж, бүх төхөөрөмжөөс гарна. Шинэ нэг удаагийн нууц үг гарна.`,
    );
    if (!ok) return;
    setError(null);
    try {
      const r = await api<{ temporaryPassword: string }>(
        `/v1/users/${account.userId}/reset-password`,
        { method: "POST", body: {} },
      );
      setPassword({ username: account.username, temporaryPassword: r.temporaryPassword });
      setDialog("password");
    } catch (e) {
      setError(actionErrorText(e));
    }
  }

  /** Lost authenticator phone (staff with two-step sign-in): it is removed and set up again at the next sign-in. */
  async function resetAuthenticator(account: { userId: string; username: string }) {
    const ok = window.confirm(
      `«${account.username}» authenticator-ыг устгах уу? Дараагийн нэвтрэлтээр дахин тохируулна. Бүх төхөөрөмжөөс гарна.`,
    );
    if (!ok) return;
    setError(null);
    try {
      await api(`/v1/users/${account.userId}/totp-reset`, { method: "POST", body: {} });
      setMessage("Authenticator-ыг устгалаа. Дараагийн нэвтрэлтээр дахин тохируулна.");
    } catch (e) {
      setError(actionErrorText(e));
    }
  }

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
              <button type="button" className={smallButton} onClick={() => setDialog("edit")}>
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
                    <button type="button" className={smallButton} onClick={() => setDialog("rank")}>
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
                    <button
                      type="button"
                      className={smallButton}
                      onClick={() => setDialog("position")}
                    >
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
                  <button type="button" className={smallButton} onClick={() => setDialog("qr")}>
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
                    {canEdit && employee.account.status === "ACTIVE" && (
                      <span className="ml-2 inline-flex flex-wrap gap-2 align-middle">
                        <button
                          type="button"
                          className={smallButton}
                          onClick={() => void resetPassword(employee.account!)}
                        >
                          Нууц үг сэргээх
                        </button>
                        {user.role === "ORG_ADMIN" && (
                          <button
                            type="button"
                            className={smallButton}
                            onClick={() => void resetAuthenticator(employee.account!)}
                          >
                            Authenticator сэргээх
                          </button>
                        )}
                      </span>
                    )}
                  </>
                ) : active ? (
                  <button
                    type="button"
                    className={smallButton}
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
                        (e) => setError(actionErrorText(e)),
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
                        <button
                          type="button"
                          className={smallButton}
                          onClick={() => setDialog("device")}
                        >
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
                <button type="button" className={smallButton} onClick={() => setDialog("disable")}>
                  Идэвхгүй болгох (ажлаас гарсан)
                </button>
              ) : employee.status === "DISABLED" ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={smallButton}
                    onClick={() => setDialog("reactivate")}
                  >
                    Дахин идэвхжүүлэх
                  </button>
                  <button
                    type="button"
                    className={smallButton}
                    onClick={() =>
                      void api(`/v1/employees/${id}/archive`, {
                        method: "POST",
                        body: user.role === "ORG_ADMIN" ? {} : {},
                      }).then(
                        () => done("Архивлалаа."),
                        (e) => setError(actionErrorText(e)),
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
        <OneTimePasswordDialog
          username={password.username}
          password={password.temporaryPassword}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
