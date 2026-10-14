"use client";

import { Modal } from "./modal";
import { primaryButton } from "./styles";

/** A new one-time password, shown once; the person changes it at the first sign-in. */
export function OneTimePasswordDialog({
  username,
  password,
  onClose,
}: {
  username: string;
  password: string;
  onClose: () => void;
}) {
  return (
    <Modal title="Нэг удаагийн нууц үг" onClose={onClose}>
      <p className="mt-2 text-sm text-slate-700">
        Нэвтрэх нэр: <b>{username}</b>
      </p>
      <p className="mt-2 rounded-md bg-slate-100 p-3 text-center font-mono text-lg">{password}</p>
      <p className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900">
        Нууц үгийг дахин харах боломжгүй. Тухайн хүнд өгнө үү; эхний нэвтрэлтээр солино.
      </p>
      <div className="mt-3 flex justify-end">
        <button type="button" className={primaryButton} onClick={onClose}>
          Хаах
        </button>
      </div>
    </Modal>
  );
}
