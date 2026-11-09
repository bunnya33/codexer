import { controlTheme, themeId } from "./themes";
import type { ControlTheme, ThemeId } from "./themes";
export type AppearancePreferences = {
  appearance: "system" | "light" | "dark";
  accent: "blue" | "green" | "purple" | "orange";
  skin: "neutral" | "paper";
};
export const defaultAppearance: AppearancePreferences = {
  appearance: "system",
  accent: "blue",
  skin: "neutral",
};
export const accentNames = { blue: "蓝色", green: "绿色", purple: "紫色", orange: "橙色" };
export function appearancePreferences(value: unknown, legacy?: unknown): AppearancePreferences {
  if (value && typeof value === "object") {
    const v = value as Partial<AppearancePreferences>;
    return {
      appearance: ["system", "light", "dark"].includes(v.appearance ?? "")
        ? v.appearance!
        : "system",
      accent: Object.hasOwn(accentNames, v.accent ?? "") ? v.accent! : "blue",
      skin: v.skin === "paper" ? "paper" : "neutral",
    };
  }
  const id = themeId(legacy);
  return legacy == null
    ? { ...defaultAppearance }
    : {
        appearance: id === "warm-dark" ? "dark" : "light",
        skin: id === "paper" ? "paper" : "neutral",
        accent: id === "paper" ? "green" : "blue",
      };
}
export function appearanceForSkin(id: ThemeId): AppearancePreferences {
  return appearancePreferences(null, id);
}
export function resolveAppearance(p: AppearancePreferences, system: string | null): ControlTheme {
  const dark = p.appearance === "dark" || (p.appearance === "system" && system === "dark");
  const base = controlTheme(dark ? "warm-dark" : p.skin === "paper" ? "paper" : "default");
  // Preserve the three existing skins exactly when their original accent is selected.
  if (p.accent === (dark ? "blue" : p.skin === "paper" ? "green" : "blue")) return base;
  const accent = (
    dark
      ? { blue: "#7d9aff", green: "#70cea1", purple: "#ba97ee", orange: "#efab69" }
      : { blue: "#3565f6", green: "#126a48", purple: "#7946bd", orange: "#a64b16" }
  )[p.accent];
  return {
    ...base,
    colors: {
      ...base.colors,
      accent,
      solid: accent,
      slider: accent,
      thumbBorder: accent,
      onAccent: dark ? "#111113" : "#ffffff",
      onSolid: dark ? "#111113" : "#ffffff",
      soft: accent + (dark ? "25" : "12"),
      mode: accent + "18",
      sliderSelectedDot: accent + "88",
    },
  };
}
