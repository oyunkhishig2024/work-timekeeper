import { useState } from "react";
import { ScrollView } from "react-native";
import type { AuthResult } from "@/lib/api";
import { ApiError, NetworkError } from "@/lib/errors";
import { errorText, mn } from "@/i18n/mn";
import { api } from "@/platform/runtime";
import { Button, ErrorText, Field, Muted, Screen, Title } from "./ui";

/** Sign in (organization code, username, password), then the authenticator code when the account has one (Org Admin, HR). */
export function LoginScreen({ onSignedIn }: { onSignedIn: (auth: AuthResult) => void }) {
  const [orgCode, setOrgCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => {
    setError(
      e instanceof NetworkError
        ? mn.errors.network
        : errorText(e instanceof ApiError ? e.code : undefined),
    );
    setBusy(false);
  };

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(orgCode.trim(), username.trim(), password);
      if (res.status === "MFA_REQUIRED") {
        setChallenge(res.challengeToken);
        setBusy(false);
      } else onSignedIn(res.auth);
    } catch (e) {
      fail(e);
    }
  }

  async function verify() {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.verifyTotp(challenge, code.trim()));
    } catch (e) {
      fail(e);
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 14 }} keyboardShouldPersistTaps="handled">
        <Title>{challenge ? mn.login.codeTitle : mn.login.title}</Title>
        {challenge ? (
          <>
            <Muted>{mn.login.codeHelp}</Muted>
            <Field
              label={mn.login.code}
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="one-time-code"
            />
            {error && <ErrorText>{error}</ErrorText>}
            <Button
              label={mn.common.continue}
              onPress={() => void verify()}
              busy={busy}
              disabled={code.trim().length < 6}
            />
          </>
        ) : (
          <>
            <Field
              label={mn.login.orgCode}
              value={orgCode}
              onChangeText={setOrgCode}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Field
              label={mn.login.username}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Field
              label={mn.login.password}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
            />
            {error && <ErrorText>{error}</ErrorText>}
            <Button
              label={mn.login.submit}
              onPress={() => void submit()}
              busy={busy}
              disabled={!orgCode.trim() || !username.trim() || !password}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
