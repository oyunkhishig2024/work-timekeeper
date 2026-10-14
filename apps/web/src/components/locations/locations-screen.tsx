"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import {
  createLocation,
  fetchAllLocations,
  parseCoordinates,
  updateLocation,
  type LocationRow,
} from "@/lib/locations";
import { Modal } from "@/components/modal";
import { fieldClass, primaryButton, smallButton } from "@/components/styles";
import { FormError } from "@/components/form-error";
import { useFieldIssue } from "../use-field-issue";

const messageOf = (e: unknown) =>
  e instanceof ApiRequestError && e.code === "LOCATION_NAME_TAKEN"
    ? "Энэ нэртэй байршил байна."
    : e instanceof ApiRequestError
      ? e.message
      : "Холбогдож чадсангүй. Дахин оролдоно уу.";

/** Org Admin: the places where attendance is recorded (PRD 13: radius 100–500 m). */
export function LocationsScreen() {
  const [rows, setRows] = useState<LocationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LocationRow | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await fetchAllLocations());
    } catch (e) {
      setError(messageOf(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Салбар (байршил)</h1>
        <button type="button" className={primaryButton} onClick={() => setEditing("new")}>
          Салбар нэмэх
        </button>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        Ажилтан энэ газрын тойрогт орж, гарахад цаг нь бүртгэгдэнэ.
      </p>
      <FormError message={error} className="mt-3 text-sm text-red-700" />
      {rows === null ? (
        <p className="mt-4 text-slate-600">Ачаалж байна…</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-slate-600">Байршил алга. «Салбар нэмэх» дарна уу.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">
                  {row.name}
                  {!row.active && <span className="ml-2 text-sm text-slate-500">(идэвхгүй)</span>}
                </p>
                <p className="text-sm text-slate-600">
                  {row.lat.toFixed(5)}, {row.lng.toFixed(5)} · радиус {row.radiusM} м
                  {row.activeEmployees !== null && ` · ${row.activeEmployees} ажилтан`}
                </p>
                {row.address && <p className="text-sm text-slate-500">{row.address}</p>}
              </div>
              <button type="button" className={smallButton} onClick={() => setEditing(row)}>
                Засах
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <LocationDialog
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function LocationDialog({
  row,
  onClose,
  onSaved,
}: {
  row: LocationRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [coords, setCoords] = useState(row ? `${row.lat}, ${row.lng}` : "");
  const [active, setActive] = useState(row?.active ?? true);
  const issues = useFieldIssue("location-form");
  const [busy, setBusy] = useState(false);
  const [accuracy, setAccuracy] = useState<number | null>(null);

  const useMyPosition = () => {
    issues.clear();
    if (!navigator.geolocation) {
      issues.failure("Энэ хөтөч байршил өгөхгүй байна.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords(`${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`);
        setAccuracy(Math.round(pos.coords.accuracy));
      },
      () => issues.failure("Байршлыг авч чадсангүй. Хөтчид байршил ашиглахыг зөвшөөрнө үү."),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const point = parseCoordinates(coords);
    if (!point) {
      issues.issue("coords", "Координат буруу байна. Жишээ: 47.918400, 106.917700");
      return;
    }
    const input = {
      name: String(form.get("name")).trim(),
      address: String(form.get("address")).trim() || null,
      lat: point.lat,
      lng: point.lng,
      radiusM: Number(form.get("radius")),
    };
    setBusy(true);
    issues.clear();
    try {
      if (row) await updateLocation(row.id, { ...input, active });
      else await createLocation(input);
      onSaved();
    } catch (e) {
      issues.failure(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={row ? "Байршил засах" : "Байршил нэмэх"} onClose={onClose}>
      <form ref={issues.formRef} onSubmit={(e) => void onSubmit(e)} className="mt-4 space-y-4">
        <label className="block text-sm font-medium">
          Нэр
          <input
            name="name"
            required
            defaultValue={row?.name}
            maxLength={120}
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          Хаяг (заавал биш)
          <input
            name="address"
            defaultValue={row?.address ?? ""}
            maxLength={300}
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          Координат (өргөрөг, уртраг)
          <input
            name="coords"
            {...issues.flag("coords")}
            value={coords}
            onChange={(e) => setCoords(e.target.value)}
            required
            placeholder="47.918400, 106.917700"
            inputMode="decimal"
            className={fieldClass}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button type="button" className={smallButton} onClick={useMyPosition}>
            Миний одоогийн байршлыг ашиглах
          </button>
          <span className="text-slate-500">
            Эсвэл Google Maps дээр газрыг баруун товшиж, эхний мөрийн тоог хуулна.
          </span>
        </div>
        {accuracy !== null && (
          <p
            role="status"
            className={`text-sm ${accuracy > 100 ? "font-medium text-red-700" : "text-slate-600"}`}
          >
            Нарийвчлал: ±{accuracy} м.
            {accuracy > 100 &&
              " Энэ байршил хэт ойролцоо биш байна (компьютер Wi-Fi-аар тооцдог). Утсаараа, яг тэр газраас дахин авна уу."}
          </p>
        )}
        <label className="block text-sm font-medium">
          Радиус, метр (100–500)
          <input
            name="radius"
            type="number"
            required
            min={100}
            max={500}
            defaultValue={row?.radiusM ?? 200}
            className={fieldClass}
          />
        </label>
        {row && (
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Идэвхтэй
          </label>
        )}
        <FormError id={issues.errorId} message={issues.message} className="text-sm text-red-700" />
        <div className="flex justify-end gap-3">
          <button type="button" className={smallButton} onClick={onClose}>
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
