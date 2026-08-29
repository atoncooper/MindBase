/**
 * 主题偏好（"system" | "light" | "dark"）的应用与持久化。
 *
 * 权威来源是 SQLite 里的 AppConfig.theme（系统设置页可改）；同时镜像一份到
 * localStorage，供 index.html 的内联脚本在首帧绘制前解析主题——否则深色用户
 * 每次启动都会闪一下白底。系统档经 matchMedia 跟随，切换实时生效。
 */

export type ThemePreference = "system" | "light" | "dark";

const MIRROR_KEY = "mb-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Normalize an untrusted value into a preference. */
function normalize(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function getThemePreference(): ThemePreference {
  try {
    return normalize(window.localStorage.getItem(MIRROR_KEY));
  } catch {
    return "system";
  }
}

/** Resolve a preference to the effective theme against the OS setting. */
function resolve(pref: ThemePreference): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** Apply the resolved theme to the document root. */
export function applyTheme(pref: ThemePreference): void {
  document.documentElement.dataset.theme = resolve(pref);
}

/**
 * Persist a preference change: mirror for the pre-paint script, apply now,
 * and let the caller decide whether to round-trip AppConfig.
 */
export function setThemePreference(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(MIRROR_KEY, pref);
  } catch {
    // Private-mode webview storage refusal — apply still works for this run.
  }
  applyTheme(pref);
}

/**
 * Bootstrap at app mount: apply the mirrored preference immediately, then
 * follow OS scheme flips live while on the 系统档.
 */
export function initTheme(): void {
  applyTheme(getThemePreference());
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (getThemePreference() === "system") applyTheme("system");
  });
}
