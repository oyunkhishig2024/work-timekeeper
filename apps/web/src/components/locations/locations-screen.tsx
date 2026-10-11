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
import { Modal, fieldClass } from "@/components/modal";

const button =
  "min-h-11 rounded-md border border-slate-300 px-3 text-sm font-medium hover:bg-slate-100";
const primary =
  "min-h-11 rounded-md bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800 disabled:opacity-60";

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
        <button type="button" className={primary} onClick={() => setEditing("new")}>
          Салбар нэмэх
        </button>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        Ажилтан энэ газрын тойрогт орж, гарахад цаг нь бүртгэгдэнэ.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
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
              <button type="button" className={button} onClick={() => setEditing(row)}>
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const useMyPosition = () => {
    setError(null);
    if (!navigator.geolocation) {
      setError("Энэ хөтөч байршил өгөхгүй байна.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setCoords(`${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`),
      () => setError("Байршлыг авч чадсангүй. Хөтчид байршил ашиглахыг зөвшөөрнө үү."),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const point = parseCoordinates(coords);
    if (!point) {
      setError("Координат буруу байна. Жишээ: 47.918400, 106.917700");
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
    setError(null);
    try {
      if (row) await updateLocation(row.id, { ...input, active });
      else await createLocation(input);
      onSaved();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={row ? "Байршил засах" : "Байршил нэмэх"} onClose={onClose}>
      <form onSubmit={(e) => void onSubmit(e)} className="mt-4 space-y-4">
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
            value={coords}
            onChange={(e) => setCoords(e.target.value)}
            required
            placeholder="47.918400, 106.917700"
            inputMode="decimal"
            className={fieldClass}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button type="button" className={button} onClick={useMyPosition}>
            Миний одоогийн байршлыг ашиглах
          </button>
          <span className="text-slate-500">
            Эсвэл Google Maps дээр газрыг баруун товшиж, эхний мөрийн тоог хуулна.
          </span>
        </div>
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
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" className={button} onClick={onClose}>
            Болих
          </button>
          <button type="submit" disabled={busy} className={primary}>
            Хадгалах
          </button>
        </div>
      </form>
    </Modal>
  );
}
