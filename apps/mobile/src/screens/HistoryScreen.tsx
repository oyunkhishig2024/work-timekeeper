import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { MyAttendance } from "@/lib/api";
import {
  groupHistory,
  hm,
  monthRange,
  summarize,
  type MonthGroup,
  type Summary,
} from "@/features/history/group";
import { mn } from "@/i18n/mn";
import { api } from "@/platform/runtime";
import { Badge, Button, Card, ErrorText, Muted, Screen, Title } from "./ui";

const monthKey = (d: Date) => d.toISOString().slice(0, 7);
const previous = (key: string) => {
  const d = new Date(`${key}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return monthKey(d);
};

function line(s: Summary): string {
  const parts = [
    `${mn.history.onTime} ${s.onTime}`,
    `${mn.history.late} ${s.late}`,
    `${mn.history.noShow} ${s.noShow}`,
  ];
  if (s.shortMinutes) parts.push(`${mn.history.short} ${hm(s.shortMinutes)}`);
  if (s.overtimeMinutes) parts.push(`${mn.history.over} ${hm(s.overtimeMinutes)}`);
  return parts.join(" · ");
}

const TONE = { ON_TIME: "ok", LATE: "warn", NO_SHOW: "bad" } as const;
const LABEL: Record<string, string> = {
  ON_TIME: mn.history.onTime,
  LATE: mn.history.late,
  NO_SHOW: mn.history.noShow,
  EXCUSED: mn.today.excused,
  PENDING: mn.today.pending,
  WORKED_OFF_DAY: mn.today.workedOffDay,
  NOT_CONFIGURED: "—",
};

const clock = (iso: string | null): string =>
  iso
    ? new Intl.DateTimeFormat("mn-MN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(iso))
    : "—";

/**
 * "Миний ирц": month folders, the newest open, weeks inside (PRD v1.28). A month is asked from the server when its folder is
 * opened (`GET /v1/me/attendance?from&to`), so the history can grow without slowing the phone down.
 */
export function HistoryScreen({ today }: { today: string }) {
  const first = monthKey(new Date(`${today}T00:00:00Z`));
  const [months, setMonths] = useState<string[]>([
    first,
    previous(first),
    previous(previous(first)),
  ]);
  const [open, setOpen] = useState<Record<string, boolean>>({ [first]: true });
  const [data, setData] = useState<Record<string, MyAttendance>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (key: string) => {
    const { from, to } = monthRange(key);
    try {
      const res = await api.myAttendance(from, to);
      setData((d) => ({ ...d, [key]: res }));
      setError(null);
    } catch {
      setError(mn.errors.network);
    }
  }, []);

  useEffect(() => {
    void load(first);
  }, [load, first]);

  function toggle(key: string) {
    const next = !open[key];
    setOpen((o) => ({ ...o, [key]: next }));
    if (next && !data[key]) void load(key);
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 10 }}>
        <Title>{mn.history.title}</Title>
        {error && <ErrorText>{error}</ErrorText>}
        {months.map((key) => {
          const res = data[key];
          const group: MonthGroup | undefined = res ? groupHistory(res.items)[0] : undefined;
          return (
            <View key={key} style={{ gap: 8 }}>
              <Card>
                <Text
                  accessibilityRole="button"
                  onPress={() => toggle(key)}
                  style={{ fontSize: 17, fontWeight: "700" }}
                >
                  {open[key] ? "▾ " : "▸ "}
                  {mn.history.monthTitle(key)}
                </Text>
                {res && <Muted>{line(summarize(res.items))}</Muted>}
              </Card>
              {open[key] && res && !group && <Muted>{mn.history.empty}</Muted>}
              {open[key] &&
                group?.weeks.map((week) => (
                  <View key={week.start} style={{ gap: 6 }}>
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: "600",
                        color: "#4B5E58",
                        paddingHorizontal: 6,
                      }}
                    >
                      {week.start.slice(5)} – {week.end.slice(5)}
                      {week.summary.shortMinutes
                        ? ` · ${mn.history.short} ${hm(week.summary.shortMinutes)}`
                        : ""}
                      {week.summary.overtimeMinutes
                        ? ` · ${mn.history.over} ${hm(week.summary.overtimeMinutes)}`
                        : ""}
                    </Text>
                    {week.days.map((d) => (
                      <Card key={d.date}>
                        <View
                          style={{
                            flexDirection: "row",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <Text style={{ fontWeight: "600" }}>{d.date.slice(5)}</Text>
                          <Badge
                            text={LABEL[d.status] ?? d.status}
                            tone={TONE[d.status as keyof typeof TONE] ?? "neutral"}
                          />
                        </View>
                        <Muted>
                          {d.arrivalAt
                            ? `${clock(d.arrivalAt)} – ${d.departureState === "LEFT" ? clock(d.departureAt) : d.departureState === "INSIDE" ? mn.today.inside : "?"}`
                            : "—"}
                        </Muted>
                        {d.earlyLeaveMinutes > 0 && (
                          <Text style={{ color: "#9A3412", fontSize: 12, fontWeight: "600" }}>
                            {mn.history.earlyLeave} · {hm(d.earlyLeaveMinutes)}
                          </Text>
                        )}
                        {d.overtimeMinutes > 0 && (
                          <Text style={{ color: "#166534", fontSize: 12, fontWeight: "600" }}>
                            {mn.history.overtime} · {hm(d.overtimeMinutes)}
                          </Text>
                        )}
                      </Card>
                    ))}
                  </View>
                ))}
            </View>
          );
        })}
        <Button
          label="…"
          kind="secondary"
          onPress={() => setMonths((m) => [...m, previous(m[m.length - 1]!)])}
        />
      </ScrollView>
    </Screen>
  );
}
