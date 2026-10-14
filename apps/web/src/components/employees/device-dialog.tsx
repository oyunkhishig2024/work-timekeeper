"use client";

import { actionErrorText } from "@/components/api-error";
import { useState } from "react";
import { api } from "@/lib/api";
import { fieldClass } from "../styles";
import { NoteDialog } from "../review/note-dialog";

export function DeviceDialog({
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
          throw new Error(actionErrorText(e));
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
