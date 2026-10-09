import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, Text } from "react-native";
import type { MyDay, Plan, PlanDay } from "@/lib/api";
import { mn } from "@/i18n/mn";
import { api, outbox } from "@/platform/runtime";
import { Badge, Button, Card, Muted, Screen, Title } from "./ui";

type SyncState = "SYNCED" | "OFFLINE" | "BLOCKED" | "SIGNED_OUT";

const clock = (iso: string | null, timeZone: string): string =>
  iso
    ? new Intl.DateTimeFormat("mn-MN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone,
      }).format(new Date(iso))
    : "—";

function statusBadge(day: MyDay | null) {
  const s = mn.today;
  switch (day?.status) {
    case "ON_TIME":
      return <Badge text={s.onTime} tone="ok" />;
    case "LATE":
      return <Badge text={s.late} tone="warn" />;
    case "EXCUSED":
      return <Badge text={s.excused} tone="neutral" />;
    case "NO_SHOW":
      return <Badge text={s.noShow} tone="bad" />;
    case "WORKED_OFF_DAY":
      return <Badge text={s.workedOffDay} tone="neutral" />;
    default:
      return <Badge text={s.pending} tone="neutral" />;
  }
}

/** Today: where and when the person is expected, what has been recorded, and whether everything reached the server. */
export function TodayScreen({
  plan,
  watching,
  sync,
  onSync,
  refreshPlan,
}: {
  plan: Plan | null;
  watching: number;
  sync: SyncState;
  onSync: () => Promise<void>;
  refreshPlan: () => Promise<void>;
}) {
  const [day, setDay] = useState<MyDay | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [busy, setBusy] = useState(false);
  const today: PlanDay | undefined = plan?.days[0];
  const timeZone = plan?.timeZone ?? "Asia/Ulaanbaatar";

  const load = useCallback(async () => {
    setWaiting(await outbox.size());
    if (!today) return;
    try {
      const res = await api.myAttendance(today.date, today.date);
      setDay(res.items[0] ?? null);
    } catch {
      // offline: keep what is shown
    }
  }, [today]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  async function refresh() {
    setBusy(true);
    await onSync();
    await refreshPlan();
    await load();
    setBusy(false);
  }

  const departure =
    day?.departureState === "LEFT"
      ? clock(day.departureAt, timeZone)
      : day?.departureState === "INSIDE"
        ? mn.today.inside
        : day?.departureState === "UNKNOWN"
          ? mn.today.unknown
          : null;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ gap: 14 }}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void refresh()} />}
      >
        <Title>{mn.today.title}</Title>
        <Card>
          <Muted>{today?.date ?? ""}</Muted>
          {statusBadge(day)}
          {day?.arrivalAt && (
            <Text>
              {mn.today.arrived}: {clock(day.arrivalAt, timeZone)}
              {day.status === "LATE" ? ` · ${day.lateMinutes} мин` : ""}
            </Text>
          )}
          {departure && (
            <Text>
              {mn.today.left}: {departure}
            </Text>
          )}
          {!day?.arrivalAt && <Muted>{mn.today.pendingHint}</Muted>}
        </Card>
        <Card>
          {today?.expected ? (
            <>
              <Text>
                {mn.today.expectedAt}: {clock(today.start, timeZone)} – {clock(today.end, timeZone)}
              </Text>
              <Text>
                {mn.today.place}: {today.locations.map((l) => l.name).join(", ")}
              </Text>
            </>
          ) : (
            <Text>{mn.today.notExpected}</Text>
          )}
          <Muted>{watching > 0 ? mn.today.watching(watching) : mn.today.notWatching}</Muted>
        </Card>
        <Card>
          <Text>{waiting > 0 ? mn.today.waiting(waiting) : mn.today.synced}</Text>
          {sync === "OFFLINE" && <Muted>{mn.today.offline}</Muted>}
          {sync === "BLOCKED" && <Muted>{mn.today.blocked}</Muted>}
          {sync === "SIGNED_OUT" && <Muted>{mn.today.signedOut}</Muted>}
        </Card>
        <Button
          label={mn.today.syncNow}
          kind="secondary"
          onPress={() => void refresh()}
          busy={busy}
        />
      </ScrollView>
    </Screen>
  );
}
