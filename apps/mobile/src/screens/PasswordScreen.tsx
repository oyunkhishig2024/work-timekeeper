import { useState } from "react";
import type { AuthResult } from "@/lib/api";
import { ApiError, NetworkError } from "@/lib/errors";
import { mn } from "@/i18n/mn";
import { api } from "@/platform/runtime";
import { Button, ErrorText, Field, Muted, Screen, Title } from "./ui";

/** The first sign-in with a temporary password ends here: a new password is required before anything else works. */
export function PasswordScreen({ onDone }: { onDone: (auth: AuthResult) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.changePassword(current, next));
    } catch (e) {
      setError(
        e instanceof NetworkError
          ? mn.errors.network
          : e instanceof ApiError
            ? e.message
            : mn.errors.unknown,
      );
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>{mn.login.newPasswordTitle}</Title>
      <Muted>{mn.login.newPasswordHelp}</Muted>
      <Field
        label={mn.login.currentPassword}
        value={current}
        onChangeText={setCurrent}
        secureTextEntry
        autoCapitalize="none"
      />
      <Field
        label={mn.login.newPassword}
        value={next}
        onChangeText={setNext}
        secureTextEntry
        autoCapitalize="none"
      />
      {error && <ErrorText>{error}</ErrorText>}
      <Button
        label={mn.common.continue}
        onPress={() => void submit()}
        busy={busy}
        disabled={!current || next.length < 10}
      />
    </Screen>
  );
}
