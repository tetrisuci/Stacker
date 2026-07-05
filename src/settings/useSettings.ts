import { useSyncExternalStore } from "react";
import type { SettingsStore } from "./store";
import type { Settings } from "./defaults";

/** Subscribe a component to the settings store; re-renders on any change. */
export function useSettings(store: SettingsStore): Settings {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
