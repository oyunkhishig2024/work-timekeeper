import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import type { Plan } from "@/lib/api";
import { captureEvent } from "@/services/geofence-capture";
import { flushOutbox } from "@/services/sync";
import { regionsChanged, regionsFromPlan, type Region } from "@/services/plan";
import { api, newId, outbox, storage } from "./runtime";

export const GEOFENCE_TASK = "tkw-geofence";
const REGIONS_KEY = "geofence.regions.v1";

/**
 * Our own seam over the geofencing library (Architecture 7.2, 7.3): the rest of the app only knows these two calls, so Spike 1 can
 * swap `expo-location` for another library without touching the screens. NOTE: the background behaviour (ENTER / EXIT delivery after
 * 2 h idle, after a reboot, on the target phone models) is exactly what Spike 1 must verify on real phones; it cannot be tested here.
 */
export interface GeofenceService {
  /** Watches exactly the places of the plan (nothing when nobody is expected). Returns how many places are watched. */
  apply(plan: Plan): Promise<number>;
  stop(): Promise<void>;
}

export const expoGeofence: GeofenceService = {
  async apply(plan) {
    const regions = regionsFromPlan(plan);
    if (regions.length === 0) {
      await this.stop();
      return 0;
    }
    const saved = await storage.getItem(REGIONS_KEY);
    const same = saved && !regionsChanged(JSON.parse(saved) as Region[], regions);
    // The platform forgets geofences after a reboot or when Play services are cleared: also register again when the task is not running.
    if (!same || !(await Location.hasStartedGeofencingAsync(GEOFENCE_TASK))) {
      await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
      await storage.setItem(REGIONS_KEY, JSON.stringify(regions));
    }
    return regions.length;
  },
  async stop() {
    if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
      await Location.stopGeofencingAsync(GEOFENCE_TASK);
    }
    await storage.removeItem(REGIONS_KEY);
  },
};

/** One quick high-accuracy fix to back the claim; failure is fine (the transition alone is still recorded). */
async function quickFix() {
  try {
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return {
      lat: p.coords.latitude,
      lng: p.coords.longitude,
      ...(p.coords.accuracy != null ? { accuracyM: p.coords.accuracy } : {}),
      mocked: p.mocked === true,
    };
  } catch {
    return null;
  }
}

// Must be defined when the module loads (index.ts imports this file first): the operating system can start the app in the
// background just to deliver a geofence event, before any screen exists.
TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error) return;
  const { eventType, region } = data as {
    eventType: Location.LocationGeofencingEventType;
    region: Location.LocationRegion;
  };
  const type = eventType === Location.LocationGeofencingEventType.Enter ? "ENTER" : "EXIT";
  if (!region.identifier) return;
  await outbox.enqueue(
    captureEvent({
      type,
      locationId: region.identifier,
      now: Date.now(),
      newId,
      fix: await quickFix(),
    }),
  );
  // upload at once; if the phone is offline the event waits in the outbox for the next try
  await flushOutbox(outbox, api);
});
