import { mn } from "@/i18n/mn";

/** What the phone reports about itself (PRD 6.8). Gathered by `gatherHealth` on the device, plain data here. */
export interface HealthInput {
  platform: "ANDROID" | "IOS";
  foregroundLocation: boolean;
  /** "Always" on iOS, "Allow all the time" on Android. */
  backgroundLocation: boolean;
  /** Precise (not approximate) location. */
  preciseLocation: boolean;
  locationServicesOn: boolean;
  /** Android battery optimisation cannot be read by the app: the person confirms it by hand. */
  batteryConfirmed: boolean;
}

export interface HealthCheck {
  key: "location_always" | "location_precise" | "location_services" | "battery";
  ok: boolean;
  title: string;
  hint: string;
  /** The person confirms it by hand (it cannot be read). */
  manual?: boolean;
}

/** The checks of the health screen (PRD 6.8, Architecture 7.5): every one has to be green before the phone records attendance. */
export function evaluateHealth(i: HealthInput): HealthCheck[] {
  const checks: HealthCheck[] = [
    {
      key: "location_always",
      ok: i.foregroundLocation && i.backgroundLocation,
      title: mn.health.locationAlways,
      hint: mn.health.locationAlwaysHint,
    },
    {
      key: "location_precise",
      ok: i.preciseLocation,
      title: mn.health.locationPrecise,
      hint: mn.health.locationPreciseHint,
    },
    {
      key: "location_services",
      ok: i.locationServicesOn,
      title: mn.health.locationServices,
      hint: mn.health.locationServicesHint,
    },
  ];
  if (i.platform === "ANDROID") {
    checks.push({
      key: "battery",
      ok: i.batteryConfirmed,
      title: mn.health.battery,
      hint: mn.health.batteryHint,
      manual: true,
    });
  }
  return checks;
}

export const allHealthy = (checks: readonly HealthCheck[]): boolean => checks.every((c) => c.ok);
