import React, { useCallback, useEffect, useState } from "react";
import { Image, View, StyleSheet } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { accountLogoSource, loadLogoVersions, type LogoVersions } from "../lib/account-logos";

/**
 * Which accounts have a logo, refreshed whenever the screen comes back into
 * view (a logo set on the website shows up after at most a minute).
 */
export function useAccountLogoVersions(): LogoVersions {
  const isFocused = useIsFocused();
  const [versions, setVersions] = useState<LogoVersions>({});
  const load = useCallback(async () => {
    setVersions(await loadLogoVersions());
  }, []);
  useEffect(() => {
    if (isFocused) void load();
  }, [isFocused, load]);
  return versions;
}

/**
 * An account's logo on a white tile, or `fallback` (the screen's usual icon)
 * when there is none or it fails to load. The white tile matches the web's
 * default framing and keeps a dark mark visible in dark mode.
 */
export function AccountLogo({
  accountId,
  version,
  size,
  fallback,
}: {
  accountId: number;
  version: number | undefined;
  size: number;
  fallback: React.ReactNode;
}) {
  const source = accountLogoSource(accountId, version);
  const key = source?.uri ?? "";
  const [failedFor, setFailedFor] = useState<string | null>(null);
  if (!source || failedFor === key) return <>{fallback}</>;
  return (
    <View
      testID={`account-logo-${accountId}`}
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      <Image
        source={source}
        accessibilityIgnoresInvertColors
        resizeMode="contain"
        style={{ width: size - 6, height: size - 6 }}
        onError={() => setFailedFor(key)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.12)",
  },
});
