import * as Location from "expo-location";
import { PermissionsAndroid, Platform } from "react-native";
import * as TaskManager from "expo-task-manager";
import type { Plan } from "@/lib/api";
import { captureEvent } from "@/services/geofence-capture";
import { flushOutbox } from "@/services/sync";
import { regionsChanged, regionsFromPlan, type Region } from "@/services/plan";
import {
  applyReported,
  emptyState,
  evaluateFix,
  distanceM,
  forRegions,
  type PresenceState,
} from "@/services/presence";
import { api, diag, newId, outbox, storage } from "./runtime";

export const GEOFENCE_TASK = "tkw-geofence";
/** The fallback: ordinary position fixes in the background (a visible notification keeps the service alive), judged by `presence.ts`. */
export const LOCATION_TASK = "tkw-location";
const REGIONS_KEY = "geofence.regions.v1";
const PRESENCE_KEY = "presence.v1";
const WATCH_FAILED_KEY = "presence.watchFailed";
/** How often the phone asks for a GPS fix while a place is watched (battery vs. how soon a departure is seen). */
export const POSITION_INTERVAL_MS = 15 * 60_000;
const LAST_NOTE_KEY = "presence.lastNote";
const CALLED_KEY = "presence.lastCalled";

/**
 * Android 13+ shows no notification (so also not the one that keeps the position watching alive) unless the app asks for the
 * permission. Without it the person also cannot switch notifications on in the phone settings.
 */
async function ensureNotificationPermission(): Promise<void> {
  if (Platform.OS !== "android" || Number(Platform.Version) < 33) return;
  const permission = "android.permission.POST_NOTIFICATIONS" as const;
  try {
    if (await PermissionsAndroid.check(permission)) return;
    const answer = await PermissionsAndroid.request(permission);
    await diag.log(`notification permission: ${answer}`);
  } catch (e) {
    await diag.log(`notification permission: ${e instanceof Error ? e.message : "error"}`);
  }
}

/**
 * The system can start the position task and the geofence task at the same moment; both read the presence state, decide and write
 * it back. Run them one after the other, or both report the same ENTER (seen on a phone: two ENTER events one second apart).
 */
let chain: Promise<unknown> = Promise.resolve();
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work);
  chain = run.catch(() => undefined);
  return run;
}

async function readRegions(): Promise<Region[]> {
  const raw = await storage.getItem(REGIONS_KEY);
  try {
    return raw ? (JSON.parse(raw) as Region[]) : [];
  } catch {
    return [];
  }
}
async function readPresence(): Promise<PresenceState> {
  const raw = await storage.getItem(PRESENCE_KEY);
  try {
    return raw ? (JSON.parse(raw) as PresenceState) : emptyState();
  } catch {
    return emptyState();
  }
}
const writePresence = (state: PresenceState) =>
  storage.setItem(PRESENCE_KEY, JSON.stringify(state));

/**
 * Our own seam over the geofencing library (Architecture 7.2, 7.3): the rest of the app only knows these two calls, so Spike 1 can
 * swap `expo-location` for another library without touching the screens. NOTE: the background behaviour (ENTER / EXIT delivery after
 * 2 h idle, after a reboot, on the target phone models) is exactly what Spike 1 must verify on real phones; it cannot be tested here.
 */
/** True when starting the position watching failed last time (retry when the app is on screen). */
export const watchingNeedsRetry = async (): Promise<boolean> =>
  (await storage.getItem(WATCH_FAILED_KEY)) === "1";

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
      await diag.log(`geofence registered with the system: ${regions.length} region(s)`);
    }
    const running = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
    await diag.log(`geofence running: ${running ? "yes" : "NO"}`);
    await writePresence(forRegions(await readPresence(), regions));
    await ensureNotificationPermission();
    try {
      // Start again every time: a service started before the notification permission was granted (or one the system stopped) is
      // still "registered" but delivers nothing. No distance filter: a phone standing still must still report its position.
      if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK);
      }
      await Location.startLocationUpdatesAsync(LOCATION_TASK, {
        accuracy: Location.Accuracy.High,
        timeInterval: POSITION_INTERVAL_MS,
        distanceInterval: 0,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: false,
        foregroundService: {
          notificationTitle: "Timekeeper Work",
          notificationBody: "Ирцийн бүртгэл ажиллаж байна",
        },
      });
      const on = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
      await diag.log(`position watching (re)started: ${on ? "yes" : "NO"}`);
      if (on) await storage.removeItem(WATCH_FAILED_KEY);
    } catch (e) {
      // Android refuses a foreground service started while the app is in the background: try again when the app is on screen.
      await storage.setItem(WATCH_FAILED_KEY, "1");
      await diag.log(
        `position watching could not start (${e instanceof Error ? e.message : "error"})`,
      );
    }
    return regions.length;
  },
  async stop() {
    if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
      await Location.stopGeofencingAsync(GEOFENCE_TASK);
    }
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    }
    await storage.removeItem(REGIONS_KEY);
    await storage.removeItem(PRESENCE_KEY);
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
TaskManager.defineTask(GEOFENCE_TASK, ({ data, error }) => inOrder(() => onGeofence(data, error)));

async function onGeofence(
  data: unknown,
  error: TaskManager.TaskManagerError | null,
): Promise<void> {
  if (error) {
    await diag.log(`geofence error: ${error.message}`);
    return;
  }
  const { eventType, region } = data as {
    eventType: Location.LocationGeofencingEventType;
    region: Location.LocationRegion;
  };
  const type = eventType === Location.LocationGeofencingEventType.Enter ? "ENTER" : "EXIT";
  if (!region.identifier) return;
  await diag.log(`geofence ${type} reported by the phone`);
  const verdict = applyReported(await readPresence(), { type, locationId: region.identifier });
  await writePresence(verdict.state);
  if (!verdict.emit) return;
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
  const sent = await flushOutbox(outbox, api);
  await diag.log(`geofence ${type}: upload ${sent.state}`);
}

// The fallback: the phone judges entering and leaving from ordinary position fixes. Also defined at start-up, for the same reason.
TaskManager.defineTask(LOCATION_TASK, ({ data, error }) => inOrder(() => onPosition(data, error)));

async function onPosition(
  data: unknown,
  error: TaskManager.TaskManagerError | null,
): Promise<void> {
  if (error) {
    await diag.log(`position error: ${error.message}`);
    return;
  }
  const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
  const calledAt = Number((await storage.getItem(CALLED_KEY)) ?? 0);
  if (Date.now() - calledAt > 120_000) {
    await storage.setItem(CALLED_KEY, String(Date.now()));
    await diag.log(`position task called (${locations?.length ?? 0} fix)`);
  }
  if (!locations || locations.length === 0) return;
  const regions = await readRegions();
  if (regions.length === 0) {
    await diag.log("position: no places stored on the phone");
    return;
  }

  let state = await readPresence();
  const before = JSON.stringify(state);
  let fired = false;
  for (const l of locations) {
    const fix = {
      lat: l.coords.latitude,
      lng: l.coords.longitude,
      ...(l.coords.accuracy != null ? { accuracyM: l.coords.accuracy } : {}),
    };
    const result = evaluateFix(state, regions, fix);
    state = result.state;
    for (const t of result.transitions) {
      fired = true;
      await diag.log(`position says ${t.type}`);
      await outbox.enqueue(
        captureEvent({
          type: t.type,
          locationId: t.locationId,
          now: l.timestamp || Date.now(),
          newId,
          fix: { ...fix, mocked: l.mocked === true },
        }),
      );
    }
  }
  if (JSON.stringify(state) !== before) await writePresence(state);

  // One short line now and then (distance to the nearest place, no coordinates), to read what the phone sees during a test.
  const last = locations[locations.length - 1]!;
  const nearest = Math.min(
    ...regions.map((r) =>
      distanceM(
        { lat: last.coords.latitude, lng: last.coords.longitude },
        { lat: r.latitude, lng: r.longitude },
      ),
    ),
  );
  const lastNote = Number((await storage.getItem(LAST_NOTE_KEY)) ?? 0);
  if (Date.now() - lastNote > 120_000) {
    await storage.setItem(LAST_NOTE_KEY, String(Date.now()));
    await diag.log(
      `position: ${Math.round(nearest)} m from the nearest place (±${Math.round(last.coords.accuracy ?? 0)} m)`,
    );
  }
  if (fired) {
    const sent = await flushOutbox(outbox, api);
    await diag.log(`position event: upload ${sent.state}`);
  }
}
