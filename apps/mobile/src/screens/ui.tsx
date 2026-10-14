import { useState, type ReactNode } from "react";
import { mn } from "@/i18n/mn";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";

export const colors = {
  bg: "#F3F5F4",
  card: "#FFFFFF",
  border: "#DCE4E1",
  text: "#14201D",
  muted: "#4B5E58",
  primary: "#0F766E",
  ok: "#166534",
  okBg: "#DCFCE7",
  warn: "#92400E",
  warnBg: "#FEF3C7",
  bad: "#991B1B",
  badBg: "#FEE2E2",
};

export function Screen({ children }: { children: ReactNode }) {
  return <View style={styles.screen}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Button({
  label,
  onPress,
  kind = "primary",
  busy,
  disabled,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary";
  busy?: boolean;
  disabled?: boolean;
}) {
  const primary = kind === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={busy || disabled}
      style={[
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonSecondary,
        (busy || disabled) && { opacity: 0.55 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? "#fff" : colors.primary} />
      ) : (
        <Text style={[styles.buttonText, { color: primary ? "#fff" : colors.primary }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** A labelled text field. A secure (password) field gets a button that shows or hides what was typed. */
export function Field({ label, ...props }: { label: string } & TextInputProps) {
  const [shown, setShown] = useState(false);
  const secure = props.secureTextEntry === true;
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      <View>
        <TextInput
          {...props}
          secureTextEntry={secure && !shown}
          accessibilityLabel={label}
          placeholderTextColor="#7C918B"
          style={[styles.input, secure && { paddingRight: 96 }]}
        />
        {secure && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={shown ? mn.common.hidePassword : mn.common.showPassword}
            onPress={() => setShown((v) => !v)}
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              minWidth: 88,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: colors.primary, fontWeight: "600" }}>
              {shown ? mn.common.hidePassword : mn.common.showPassword}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="alert" style={styles.error}>
      {children}
    </Text>
  );
}

export function Badge({ text, tone }: { text: string; tone: "ok" | "warn" | "bad" | "neutral" }) {
  const map = {
    ok: [colors.okBg, colors.ok],
    warn: [colors.warnBg, colors.warn],
    bad: [colors.badBg, colors.bad],
    neutral: ["#E8ECEA", colors.muted],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View
      style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}
    >
      <Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingTop: 48,
    paddingHorizontal: 20,
    paddingBottom: 16,
    gap: 14,
  },
  title: { fontSize: 26, fontWeight: "700", color: colors.text },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 16,
    gap: 6,
  },
  button: {
    minHeight: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonSecondary: { backgroundColor: "#fff", borderWidth: 1, borderColor: colors.primary },
  buttonText: { fontSize: 16, fontWeight: "600" },
  label: { fontSize: 13, color: colors.muted },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: "#C9D4D0",
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
    backgroundColor: "#fff",
    color: colors.text,
  },
  error: { color: colors.bad, fontSize: 14 },
});
