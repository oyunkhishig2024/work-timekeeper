import * as Location from "expo-location";
import { Platform } from "react-native";
import { evaluateHealth, type HealthCheck } from "@/services/health";
import { storage } from "./runtime";

const BATTERY_KEY = "health.battery.confirmed";

export async function confirmBattery(): Promise<void> {
  await storage.setItem(BATTERY_KEY, "1");
}

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
    batteryConfirmed: (await storage.getItem(BATTERY_KEY)) === "1",
  });
}

/** Asks for the location permissions step by step: first while using the app, then "always" (the system shows its own dialogs). */
export async function requestLocationPermissions(): Promise<void> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.granted) await Location.requestBackgroundPermissionsAsync();
}
