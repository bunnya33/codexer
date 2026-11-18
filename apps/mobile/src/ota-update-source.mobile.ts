import * as Updates from "expo-updates";

export function clearOtaUpdateSource() {
  if (Updates.isEnabled) Updates.setUpdateRequestHeadersOverride(null);
}
