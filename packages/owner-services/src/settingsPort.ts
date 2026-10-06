import type { Settings } from "@domo/owner-core/settings";

export interface SettingsPort {
  load(): Settings;
  save(settings: Settings): void;
}
