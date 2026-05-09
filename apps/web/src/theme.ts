export type ThemePreference = "light" | "dark";

export function resolveInitialTheme(
  storedTheme: string | null,
  prefersDark: boolean,
): ThemePreference {
  if (storedTheme === "light" || storedTheme === "dark") {
    return storedTheme;
  }
  return prefersDark ? "dark" : "light";
}
