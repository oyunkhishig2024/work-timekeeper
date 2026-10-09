import { useCallback, useEffect, useState } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import { mn } from "@/i18n/mn";
import { confirmBattery, gatherHealth, requestLocationPermissions } from "@/platform/health";
import { allHealthy, type HealthCheck } from "@/services/health";
import { Badge, Button, Card, Muted, Screen, Title } from "./ui";

/** The phone check (PRD 6.8) and sign-out. Every check has to be green for ENTER / EXIT to be delivered in the background. */
export function DeviceScreen({
  onChecked,
  onSignOut,
}: {
  onChecked: (healthy: boolean) => void;
  onSignOut: () => void;
}) {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);

  const load = useCallback(async () => {
    const next = await gatherHealth();
    setChecks(next);
    onChecked(allHealthy(next));
  }, [onChecked]);

  useEffect(() => {
    void load();
  }, [load]);

  async function fix(check: HealthCheck) {
    if (check.manual) {
      await confirmBattery();
    } else if (check.key === "location_always") {
      await requestLocationPermissions();
    } else {
      await Linking.openSettings();
    }
    await load();
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        <Title>{mn.health.title}</Title>
        <Muted>{mn.health.help}</Muted>
        {checks?.map((c) => (
          <Card key={c.key}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Text style={{ fontWeight: "600", flex: 1 }}>{c.title}</Text>
              <Badge text={c.ok ? "✓" : "!"} tone={c.ok ? "ok" : "warn"} />
            </View>
            <Muted>{c.hint}</Muted>
            {!c.ok && (
              <Button
                label={
                  c.manual
                    ? mn.health.confirm
                    : c.key === "location_always"
                      ? mn.health.grant
                      : mn.health.openSettings
                }
                kind="secondary"
                onPress={() => void fix(c)}
              />
            )}
          </Card>
        ))}
        {checks && allHealthy(checks) && <Muted>{mn.health.allGood}</Muted>}
        <Button label={mn.login.signOut} kind="secondary" onPress={onSignOut} />
      </ScrollView>
    </Screen>
  );
}
