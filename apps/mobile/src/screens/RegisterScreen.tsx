import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { View } from "react-native";
import { ApiError, NetworkError } from "@/lib/errors";
import { parseRegistrationQr } from "@/lib/qr";
import { errorText, mn } from "@/i18n/mn";
import { describeDevice } from "@/platform/device";
import { api } from "@/platform/runtime";
import { Button, ErrorText, Muted, Screen, Title } from "./ui";

/** Registers this phone with the QR code from HR (PRD 5, Architecture 7.6). The server checks the QR, the signed consent and the employee. */
export function RegisterScreen({ onRegistered }: { onRegistered: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false); // the camera reports the same code many times

  async function onCode(payload: string) {
    if (handled.current) return;
    handled.current = true;
    setScanning(false);
    const token = parseRegistrationQr(payload);
    if (!token) {
      setError(mn.register.notOurQr);
      handled.current = false;
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.registerDevice(await describeDevice(token));
      onRegistered();
    } catch (e) {
      setError(
        e instanceof NetworkError
          ? mn.errors.network
          : errorText(e instanceof ApiError ? e.code : undefined),
      );
      setBusy(false);
      handled.current = false;
    }
  }

  async function start() {
    setError(null);
    const granted = permission?.granted ? true : (await requestPermission()).granted;
    if (!granted) return setError(mn.register.cameraDenied);
    handled.current = false;
    setScanning(true);
  }

  if (scanning) {
    return (
      <Screen>
        <Title>{mn.register.title}</Title>
        <Muted>{mn.register.scanning}</Muted>
        <View style={{ flex: 1, borderRadius: 16, overflow: "hidden" }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => void onCode(data)}
          />
        </View>
        <Button label={mn.common.cancel} kind="secondary" onPress={() => setScanning(false)} />
      </Screen>
    );
  }
  return (
    <Screen>
      <Title>{mn.register.title}</Title>
      <Muted>{mn.register.help}</Muted>
      {error && <ErrorText>{error}</ErrorText>}
      <View style={{ flex: 1 }} />
      <Button label={mn.register.scan} onPress={() => void start()} busy={busy} />
    </Screen>
  );
}
