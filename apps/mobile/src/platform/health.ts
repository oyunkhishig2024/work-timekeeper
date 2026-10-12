import * as Device from "expo-device";
import * as Location from "expo-location";
import { Platform } from "react-native";
import { evaluateHealth, type HealthCheck } from "@/services/health";
import { storage } from "./runtime";

const confirmedKey = (key: string) => `health.${key}.confirmed`;

/** The person says they did a setting that the app cannot read (battery, Autostart). */
export async function confirmManual(key: string): Promise<void> {
  await storage.setItem(confirmedKey(key), "1");
}

const isXiaomiFamily = (): boolean =>
  /xiaomi|redmi|poco/i.test(`${Device.manufacturer ?? ""} ${Device.brand ?? ""}`);

/** Reads the permissions and settings of this phone and evaluates the health checks (PRD 6.8). */
export async function gatherHealth(): Promise<HealthCheck[]> {
  const foreground = await Location.getForegroundPermissionsAsync();
  const background = await Location.getBackgroundPermissionsAsync();
  const services = await Location.hasServicesEnabledAsync();
  const precise =
    Platform.OS === "android"
      ? foreground.android?.accuracy === "fine"
      : foreground.ios?.scope !== "whenInUse" || foreground.granted; // iOS reports precision per app; "always" is checked above
  return evaluateHealth({
    platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
    foregroundLocation: foreground.granted,
    backgroundLocation: background.granted,
    preciseLocation: foreground.granted && precise,
    locationServicesOn: services,
    batteryConfirmed: (await storage.getItem(confirmedKey("battery"))) === "1",
    autostart: {
      needed: Platform.OS === "android" && isXiaomiFamily(),
      confirmed: (await storage.getItem(confirmedKey("autostart"))) === "1",
    },
  });
}

/** Asks for the location permissions step by step: first while using the app, then "always" (the system shows its own dialogs). */
export async function requestLocationPermissions(): Promise<void> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.granted) await Location.requestBackgroundPermissionsAsync();
}
