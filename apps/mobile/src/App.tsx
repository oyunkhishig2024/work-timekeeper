import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, Text, View } from "react-native";
import type { AuthResult, Plan } from "@/lib/api";
import { ApiError, NetworkError, SessionEndedError } from "@/lib/errors";
import { mn } from "@/i18n/mn";
import { expoGeofence } from "@/platform/geofence";
import { api, outbox, setSessionEndedHandler, tokenStore } from "@/platform/runtime";
import { flushOutbox } from "@/services/sync";
import { DeviceScreen } from "@/screens/DeviceScreen";
import { HistoryScreen } from "@/screens/HistoryScreen";
import { LoginScreen } from "@/screens/LoginScreen";
import { PasswordScreen } from "@/screens/PasswordScreen";
import { RegisterScreen } from "@/screens/RegisterScreen";
import { TodayScreen } from "@/screens/TodayScreen";
import { Button, colors, Muted, Screen, Title } from "@/screens/ui";

type Stage = "boot" | "login" | "password" | "totp" | "unlinked" | "register" | "main";
type Tab = "today" | "history" | "device";
type SyncState = "SYNCED" | "OFFLINE" | "BLOCKED" | "SIGNED_OUT";

const PLAN_REFRESH_MS = 30 * 60_000;

/**
 * The app shell: sign in → (new password) → register this phone with the HR QR → Today / History / Phone. While the main screens
 * are shown the app keeps three things going: the geofences of the plan, the upload of the outbox and the heartbeat.
 */
export default function App() {
  const [stage, setStage] = useState<Stage>("boot");
  const [tab, setTab] = useState<Tab>("today");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [watching, setWatching] = useState(0);
  const [sync, setSync] = useState<SyncState>("SYNCED");
  const lastPlan = useRef(0);

  // ------------------------------------------------------------------ where the person is in the sign-in flow

  const afterAuth = useCallback(async (auth?: AuthResult) => {
    if (auth?.requires.includes("PASSWORD_CHANGE")) return setStage("password");
    if (auth?.requires.includes("TOTP_SETUP")) return setStage("totp");
    try {
      const state = await api.myDevice();
      setStage(state.device?.status === "ACTIVE" ? "main" : "register");
    } catch (e) {
      if (e instanceof ApiError && e.code === "EMPLOYEE_ONLY") return setStage("unlinked");
      if (e instanceof ApiError && e.code === "SETUP_REQUIRED") return setStage("password");
      if (e instanceof SessionEndedError || (e instanceof ApiError && e.status === 401))
        return setStage("login");
      if (e instanceof NetworkError) return setStage("main"); // offline: the cached app still records events; it checks again later
      throw e;
    }
  }, []);

  useEffect(() => {
    setSessionEndedHandler(() => setStage("login"));
    void (async () => {
      if (!(await tokenStore.read())) return setStage("login");
      await afterAuth();
    })();
  }, [afterAuth]);

  const signOut = useCallback(async () => {
    await expoGeofence.stop().catch(() => undefined);
    await api.logout();
    setPlan(null);
    setWatching(0);
    setStage("login");
  }, []);

  // ------------------------------------------------------------------ the work of the main screens

  const upload = useCallback(async () => {
    const result = await flushOutbox(outbox, api);
    setSync(result.state === "EMPTY" || result.state === "DONE" ? "SYNCED" : result.state);
    if (result.state === "SIGNED_OUT") setStage("login");
    if (result.state !== "OFFLINE") void api.heartbeat().catch(() => undefined);
  }, []);

  const refreshPlan = useCallback(async () => {
    try {
      const next = await api.plan();
      lastPlan.current = Date.now();
      setPlan(next);
      try {
        setWatching(await expoGeofence.apply(next));
      } catch {
        setWatching(0); // no "always" permission yet: the Phone tab shows what is missing
      }
    } catch {
      // offline: the geofences already registered keep working
    }
  }, []);

  useEffect(() => {
    if (stage !== "main") return;
    void upload();
    void refreshPlan();
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void upload();
      if (Date.now() - lastPlan.current > PLAN_REFRESH_MS) void refreshPlan();
    });
    const timer = setInterval(() => void upload(), 5 * 60_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [stage, upload, refreshPlan]);

  // ------------------------------------------------------------------ screens

  let body;
  switch (stage) {
    case "boot":
      body = (
        <Screen>
          <ActivityIndicator color={colors.primary} />
        </Screen>
      );
      break;
    case "login":
      body = <LoginScreen onSignedIn={(auth) => void afterAuth(auth)} />;
      break;
    case "password":
      body = <PasswordScreen onDone={(auth) => void afterAuth(auth)} />;
      break;
    case "totp":
      body = (
        <Screen>
          <Title>{mn.login.codeTitle}</Title>
          <Muted>{mn.login.setupTotp}</Muted>
          <Button label={mn.login.signOut} kind="secondary" onPress={() => void signOut()} />
        </Screen>
      );
      break;
    case "unlinked":
      body = (
        <Screen>
          <Title>{mn.errors.EMPLOYEE_ONLY ?? mn.errors.unknown}</Title>
          <Button label={mn.login.signOut} kind="secondary" onPress={() => void signOut()} />
        </Screen>
      );
      break;
    case "register":
      body = <RegisterScreen onRegistered={() => setStage("main")} />;
      break;
    case "main":
      body =
        tab === "today" ? (
          <TodayScreen
            plan={plan}
            watching={watching}
            sync={sync}
            onSync={upload}
            refreshPlan={refreshPlan}
          />
        ) : tab === "history" ? (
          <HistoryScreen today={plan?.days[0]?.date ?? new Date().toISOString().slice(0, 10)} />
        ) : (
          <DeviceScreen onChecked={() => void refreshPlan()} onSignOut={() => void signOut()} />
        );
      break;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="dark" />
      <View style={{ flex: 1 }}>{body}</View>
      {stage === "main" && (
        <View
          style={{
            flexDirection: "row",
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: "#fff",
          }}
        >
          {(["today", "history", "device"] as const).map((t) => (
            <Pressable
              key={t}
              accessibilityRole="tab"
              onPress={() => setTab(t)}
              style={{ flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ fontWeight: "600", color: tab === t ? colors.primary : colors.muted }}>
                {mn.tabs[t]}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
