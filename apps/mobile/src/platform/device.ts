import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { RegisterInput } from "@/lib/api";
import { appVersion } from "./runtime";

const KEY = "tkw.installKey";

/**
 * The identifier of this install that the server remembers (`attestationKeyId`). The target design is a key pair made in secure
 * hardware with Play Integrity / App Attest proof (Architecture 7.6, PRD 6.7); until those native bridges exist this is a random
 * value kept in the secure keystore. The server records such registrations as UNVERIFIED.
 */
async function installKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY);
  if (existing) return existing;
  const created = Crypto.randomUUID();
  await SecureStore.setItemAsync(KEY, created);
  return created;
}

/** What the registration call sends about this phone. */
export async function describeDevice(qrToken: string): Promise<RegisterInput> {
  return {
    qrToken,
    platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
    ...(Device.modelName ? { model: Device.modelName } : {}),
    ...(Device.osVersion ? { osVersion: Device.osVersion } : {}),
    appVersion: Application.nativeApplicationVersion ?? appVersion,
    attestationKeyId: await installKey(),
  };
}
