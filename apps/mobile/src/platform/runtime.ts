import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { ApiClient, type TokenStore, type Tokens } from "@/lib/api";
import { Outbox, type KeyValueStore } from "@/services/outbox";

const TOKENS_KEY = "tkw.tokens";

/** The tokens live in the secure keystore of the phone (Android Keystore / iOS Keychain), never in plain storage. */
export const tokenStore: TokenStore = {
  async read() {
    const raw = await SecureStore.getItemAsync(TOKENS_KEY);
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as Tokens;
      return t.accessToken && t.refreshToken ? t : null;
    } catch {
      return null;
    }
  },
  write: (tokens) => SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(tokens)),
  clear: () => SecureStore.deleteItemAsync(TOKENS_KEY),
};

const kv: KeyValueStore = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};
export const storage = kv;

export const appVersion: string = Constants.expoConfig?.version ?? "0.0.0";
export const apiUrl: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  "http://localhost:3001";

let onSessionEnded: () => void = () => undefined;
/** The app shell registers what happens when the session ends for good (back to the sign-in screen). */
export const setSessionEndedHandler = (handler: () => void) => {
  onSessionEnded = handler;
};

/** One client and one outbox for the whole app, also for the background geofence task (it runs in the same JS runtime). */
export const api = new ApiClient({
  baseUrl: apiUrl,
  tokens: tokenStore,
  appVersion,
  onSessionEnded: () => onSessionEnded(),
});
export const outbox = new Outbox(kv);

export const newId = (): string => Crypto.randomUUID();
