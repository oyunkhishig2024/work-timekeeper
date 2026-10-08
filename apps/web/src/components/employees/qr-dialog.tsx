"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import type { ReplacementQr } from "@/lib/employees";
import { fieldClass, Modal, primaryButton, secondaryButton } from "../modal";

/**
 * A replacement QR for a new phone (PRD 5, 21.1): employee-specific, single use. The code is shown once, here; the API keeps only
 * its hash. An Org Admin may add a consent override with a reason (PRD 15.4).
 */
export function ReplacementQrDialog({
  employeeId,
  fullName,
  canOverride,
  onClose,
}: {
  employeeId: string;
  fullName: string;
  canOverride: boolean;
  onClose: () => void;
}) {
  const [hours, setHours] = useState("24");
  const [override, setOverride] = useState("");
  const [qr, setQr] = useState<ReplacementQr | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!qr) return;
    let alive = true;
    void QRCode.toDataURL(qr.qrPayload, { width: 280, margin: 2, errorCorrectionLevel: "M" }).then(
      (url) => alive && setImage(url),
    );
    return () => {
      alive = false;
    };
  }, [qr]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setQr(
        await api<ReplacementQr>(`/v1/employees/${employeeId}/replacement-qr`, {
          method: "POST",
          body: {
            expiresInHours: Number(hours),
            ...(canOverride && override.trim() ? { consentOverrideReason: override.trim() } : {}),
          },
        }),
      );
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "QR үүсгэж чадсангүй.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Утас солих QR" onClose={onClose}>
      <p className="mt-1 text-sm text-slate-700">{fullName}</p>
      {!qr ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-slate-700">
            Энэ QR зөвхөн энэ ажилтанд, нэг удаа хэрэглэгдэнэ. Шинэ утсаараа нэвтэрсний дараа
            уншуулна. Хуучин утас идэвхгүй болно.
          </p>
          <label className="block text-sm font-medium">
            Хүчинтэй хугацаа (цаг)
            <input
              type="number"
              min={1}
              max={720}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className={fieldClass}
            />
          </label>
          {canOverride && (
            <label className="block text-sm font-medium">
              Зөвшөөрлийн хуудасгүйгээр бүртгэх шалтгаан (заавал биш, дор хаяж 5 тэмдэгт)
              <input
                value={override}
                onChange={(e) => setOverride(e.target.value)}
                maxLength={500}
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
            <button
              type="button"
              disabled={busy}
              className={primaryButton}
              onClick={() => void create()}
            >
              QR үүсгэх
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 text-center">
          {image ? (
            <img
              src={image}
              alt="Утас бүртгэх QR код"
              width={280}
              height={280}
              className="mx-auto"
            />
          ) : (
            <p>Үүсгэж байна…</p>
          )}
          <p className="mt-2 text-sm text-slate-700">
            Хүчинтэй:{" "}
            {new Date(qr.expiresAt).toLocaleString("mn-MN", { timeZone: "Asia/Ulaanbaatar" })}{" "}
            хүртэл · нэг удаа
          </p>
          <p className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900">
            Энэ кодыг дахин харах боломжгүй. Хаахаасаа өмнө ажилтанд уншуулна уу.
          </p>
          <div className="mt-3 flex justify-end">
            <button type="button" className={primaryButton} onClick={onClose}>
              Хаах
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
