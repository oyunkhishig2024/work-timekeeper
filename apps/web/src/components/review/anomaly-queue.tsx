"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiRequestError } from "@/lib/api";
import { fetchOrganization, formatTime, type Organization } from "@/lib/attendance";
import {
  decisionProblem,
  fetchAnomalies,
  FLAG_INFO,
  mapUrl,
  parseReviewState,
  QUEUE_LABEL,
  reviewEvent,
  reviewHref,
  REVIEW_LABEL,
  type AnomalyItem,
  type AnomalyResponse,
  type Decision,
  type QueueFilter,
} from "@/lib/review";
import { secondaryButton } from "../modal";
import { NoteDialog } from "./note-dialog";
import { ReviewTabs } from "./review-tabs";

const FILTERS: QueueFilter[] = ["OPEN", "ALL", "CONFIRMED", "REJECTED"];
const dateTime = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

function errorText(e: unknown): string {
  return e instanceof ApiRequestError
    ? e.message
    : "Мэдээллийг уншиж чадсангүй. Дахин оролдоно уу.";
}

/** Anomaly Review Queue (PRD 6.7): suspicious events are accepted and flagged; HR confirms, rejects or asks for a re-check. */
export function AnomalyQueue() {
  const params = useSearchParams();
  const state = useMemo(() => parseReviewState(params), [params]);
  const [org, setOrg] = useState<Organization | null>(null);
  const [data, setData] = useState<AnomalyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    item: AnomalyItem;
    decision: Exclude<Decision, "CONFIRM">;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    fetchOrganization().then(setOrg, (e) => setError(errorText(e)));
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await fetchAnomalies(state));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [state]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  async function decide(item: AnomalyItem, decision: Decision, note: string) {
    await reviewEvent(item.id, decision, note);
    setMessage(
      decision === "CONFIRM"
        ? "Баталгаажууллаа."
        : decision === "REJECT"
          ? "Няцаалаа, өдрийн ирцийг дахин бодлоо."
          : "Дахин шалгах хүсэлтийг тэмдэглэлээ.",
    );
    setVersion((v) => v + 1);
    await load();
  }

  async function confirm(item: AnomalyItem) {
    setBusyId(item.id);
    try {
      await decide(item, "CONFIRM", "");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  }

  const repeated = data?.repeated.employees ?? [];
  return (
    <div>
      <h1 className="text-2xl font-semibold">Хяналт</h1>
      <ReviewTabs refresh={version} />

      <p className="mt-4 text-sm text-slate-700">
        Сэжигтэй event-ийг хүлээн авч, тэмдэглээд ирцэд тооцдог. Та баталгаажуулж, няцааж (тэр event
        ирцэд тооцогдохгүй болж, өдөр дахин бодогдоно) эсвэл дахин шалгахыг хүсч болно.
      </p>

      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Төлөвөөр шүүх">
        {FILTERS.map((f) => (
          <li key={f}>
            <Link
              href={reviewHref({ status: f, employeeId: state.employeeId })}
              aria-current={state.status === f ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm ${
                state.status === f
                  ? "border-teal-700 bg-teal-700 text-white"
                  : "border-slate-300 bg-white hover:bg-slate-100"
              }`}
            >
              {QUEUE_LABEL[f]}
            </Link>
          </li>
        ))}
        {state.employeeId && (
          <li>
            <Link
              href={reviewHref({ status: state.status })}
              className="inline-flex min-h-11 items-center px-3 text-sm text-teal-700 underline"
            >
              Ажилтны шүүлтүүрийг арилгах ✕
            </Link>
          </li>
        )}
      </ul>

      {repeated.length > 0 && (
        <section
          aria-label="Давтагдсан"
          className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3"
        >
          <h2 className="text-sm font-semibold text-amber-900">
            {data!.repeated.days} хоногт {data!.repeated.threshold}-аас олон удаа тэмдэглэгдсэн
            ажилтан
          </h2>
          <ul className="mt-1 flex flex-wrap gap-2 text-sm">
            {repeated.map((e) => (
              <li key={e.employeeId}>
                <Link
                  href={reviewHref({ status: "ALL", employeeId: e.employeeId })}
                  className="inline-flex min-h-11 items-center rounded-full bg-white px-3 underline"
                >
                  {e.fullName} · {e.count}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(error || message) && (
        <p
          role={error ? "alert" : "status"}
          className={`mt-3 rounded-md p-3 text-sm ${error ? "bg-red-50 text-red-800" : "bg-teal-50 text-teal-900"}`}
        >
          {error ?? message}
        </p>
      )}
      {!data && !error && <p className="mt-4 text-slate-600">Ачаалж байна…</p>}
      {data && data.items.length === 0 && (
        <p className="mt-4 text-slate-600">
          {state.status === "OPEN" ? "Шалгах event байхгүй байна." : "Жагсаалт хоосон байна."}
        </p>
      )}
      {data && org && (
        <ul className="mt-4 space-y-3">
          {data.items.map((item) => (
            <Card
              key={item.id}
              item={item}
              timeZone={org.timeZone}
              busy={busyId === item.id}
              onConfirm={() => void confirm(item)}
              onDialog={(decision) => setDialog({ item, decision })}
            />
          ))}
        </ul>
      )}
      {data && data.total > data.items.length && (
        <p className="mt-3 text-sm text-slate-600">
          Эхний {data.items.length} / {data.total} харуулав. Ажилтнаар шүүж нарийвчилна уу.
        </p>
      )}

      {dialog && (
        <NoteDialog
          title={dialog.decision === "REJECT" ? "Event-ийг няцаах" : "Дахин шалгахыг хүсэх"}
          intro={`${dialog.item.fullName} · ${org ? dateTime(dialog.item.occurredAt, org.timeZone) : ""}`}
          label={dialog.decision === "REJECT" ? "Няцаах шалтгаан" : "Тэмдэглэл"}
          required={dialog.decision === "REJECT"}
          submitLabel={dialog.decision === "REJECT" ? "Няцаах" : "Хүсэх"}
          validate={(note) => decisionProblem(dialog.decision, note)}
          onSubmit={async (note) => {
            try {
              await decide(dialog.item, dialog.decision, note);
              setDialog(null);
            } catch (e) {
              throw new Error(errorText(e));
            }
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function Card({
  item,
  timeZone,
  busy,
  onConfirm,
  onDialog,
}: {
  item: AnomalyItem;
  timeZone: string;
  busy: boolean;
  onConfirm: () => void;
  onDialog: (decision: "REJECT" | "REQUEST_RECHECK") => void;
}) {
  const open = item.reviewStatus === "PENDING" || item.reviewStatus === "RECHECK_REQUESTED";
  const skew = item.claimedAt ? formatTime(item.claimedAt, timeZone) : null;
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">
            {item.fullName}{" "}
            <span className="text-sm font-normal text-slate-500">{item.employeeNo}</span>
          </p>
          <p className="text-sm text-slate-700">
            {item.type === "ENTER" ? "Орсон" : "Гарсан"} · {item.locationName} ·{" "}
            {dateTime(item.occurredAt, timeZone)}
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            item.reviewStatus === "REJECTED"
              ? "bg-red-100 text-red-900"
              : item.reviewStatus === "CONFIRMED"
                ? "bg-green-100 text-green-900"
                : item.reviewStatus === "RECHECK_REQUESTED"
                  ? "bg-amber-100 text-amber-900"
                  : "bg-slate-100 text-slate-800"
          }`}
        >
          {item.reviewStatus ? REVIEW_LABEL[item.reviewStatus] : "—"}
        </span>
      </div>

      <ul className="mt-3 space-y-1">
        {item.flags.map((flag) => {
          const info = FLAG_INFO[flag];
          return (
            <li key={flag} className="text-sm">
              <span
                className={`mr-2 rounded-full px-2 py-0.5 text-xs font-medium ${
                  info?.suspicious === false
                    ? "bg-slate-100 text-slate-800"
                    : "bg-red-100 text-red-900"
                }`}
              >
                {info?.label ?? flag}
              </span>
              <span className="text-slate-700">{info?.help ?? ""}</span>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-xs text-slate-600">
        {item.counted ? "Ирцэд тооцогдож байна" : "Ирцэд тооцогдохгүй"}
        {item.accuracyM !== null ? ` · нарийвчлал ${Math.round(item.accuracyM)} м` : ""}
        {skew ? ` · утасны цаг ${skew}` : ""}
        {item.lat !== null && item.lng !== null ? (
          <>
            {" · "}
            <a
              href={mapUrl(item.lat, item.lng)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal-700 underline"
            >
              {item.lat.toFixed(5)}, {item.lng.toFixed(5)} (газрын зураг)
            </a>
          </>
        ) : null}
      </p>

      {item.reviewedByName && (
        <p className="mt-1 text-xs text-slate-600">
          {item.reviewedByName} · {item.reviewedAt ? dateTime(item.reviewedAt, timeZone) : ""}
          {item.reviewNote ? ` · «${item.reviewNote}»` : ""}
        </p>
      )}

      {open && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            className="min-h-11 rounded-md bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
            onClick={onConfirm}
          >
            Баталгаажуулах
          </button>
          <button
            type="button"
            disabled={busy}
            className={secondaryButton}
            onClick={() => onDialog("REJECT")}
          >
            Няцаах
          </button>
          {item.reviewStatus === "PENDING" && (
            <button
              type="button"
              disabled={busy}
              className={secondaryButton}
              onClick={() => onDialog("REQUEST_RECHECK")}
            >
              Дахин шалгахыг хүсэх
            </button>
          )}
        </div>
      )}
    </li>
  );
}
