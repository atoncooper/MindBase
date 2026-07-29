"use client";

import { useEffect, useState } from "react";
import {
  preferencesApi,
  type WallpaperPref,
} from "@/lib/api";
import WallpaperPicker from "@/components/WallpaperPicker";
import { useTheme } from "@/components/ThemeProvider";

const DEFAULT_WP: WallpaperPref = {
  source: "preset",
  key: "default",
  version: 1,
  type: "image",
};

const MOTION_KEY = "wallpaper_motion";
const FALLBACK_STATIC = "/wallpapers/presets/default.jpg";

/** Build a cacheable URL for a wallpaper preference. */
function wallpaperUrl(wp: WallpaperPref): string {
  if (wp.source === "preset") {
    const ext = wp.type === "video" ? "mp4" : "jpg";
    return `/wallpapers/presets/${encodeURIComponent(wp.key)}.${ext}`;
  }
  // custom: backend proxy -> MinIO; ?v= busts browser cache on new upload
  return `/wallpaper/file/${wp.key}?v=${wp.version}`;
}

interface Props {
  session: string | null;
  dimmed: boolean;
  onAddWidget?: () => void;
}

/**
 * Full-screen macOS-style wallpaper background.
 *
 * - Loads the user's wallpaper preference on login (falls back to default).
 * - Supports video (mp4) dynamic wallpapers; a "动态壁纸" toggle in the
 *   right-click menu lets users disable motion (falls back to a static image).
 * - Right-click (context menu) -> "更换壁纸" / "添加组件".
 * - `dimmed` overlays a dark scrim when a dock panel is open.
 */
export default function WallpaperBackground({ session, dimmed, onAddWidget }: Props) {
  const [wp, setWp] = useState<WallpaperPref>(DEFAULT_WP);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const { theme, toggle } = useTheme();

  // Load motion preference on mount.
  useEffect(() => {
    const stored = localStorage.getItem(MOTION_KEY);
    if (stored !== null) setMotionEnabled(stored !== "false");
  }, []);

  // Load wallpaper preference after login.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await preferencesApi.get();
        if (!cancelled && res.preferences?.wallpaper) setWp(res.preferences.wallpaper);
      } catch {
        // silent: keep default wallpaper
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Dismiss the context menu on outside click / Esc.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Document-level contextmenu listener (wallpaper-layer sits below app-shell
  // and cannot receive contextmenu directly). Defer to the native menu inside
  // inputs / panels / dock / topbar (macOS-like desktop right-click).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, [contenteditable], .floating-panel, .dock-bar, .app-topbar, .wallpaper-picker"
        )
      ) {
        setMenu(null);
        return;
      }
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  const applyWallpaper = (next: WallpaperPref) => {
    setWp(next);
    setPickerOpen(false);
    setMenu(null);
  };

  const toggleMotion = () => {
    const next = !motionEnabled;
    setMotionEnabled(next);
    localStorage.setItem(MOTION_KEY, String(next));
    setMenu(null);
  };

  const isVideo = wp.type === "video";
  const showVideo = isVideo && motionEnabled;
  // When motion is off for a video wallpaper, fall back to a static image.
  const staticUrl = isVideo && !motionEnabled ? FALLBACK_STATIC : wallpaperUrl(wp);

  return (
    <>
      <div className={`wallpaper-layer${dimmed ? " is-dimmed" : ""}`}>
        {showVideo ? (
          <video
            src={wallpaperUrl(wp)}
            autoPlay
            loop
            muted
            playsInline
            className="wallpaper-img"
            draggable={false}
          />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={staticUrl}
            alt=""
            className="wallpaper-img"
            draggable={false}
          />
        )}
        <div className="wallpaper-overlay" />
      </div>

      {menu && (
        <div
          className="wallpaper-context-menu"
          style={{
            left: Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 180),
            top: Math.min(menu.y, (typeof window !== "undefined" ? window.innerHeight : 9999) - 180),
          }}
        >
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              setMenu(null);
              setPickerOpen(true);
            }}
          >
            更换壁纸…
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={toggleMotion}
          >
            动态壁纸{motionEnabled ? " ✓" : ""}
          </button>
          {onAddWidget && (
            <button
              type="button"
              className="context-menu-item"
              onClick={() => {
                setMenu(null);
                onAddWidget();
              }}
            >
              添加组件…
            </button>
          )}
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              setMenu(null);
              toggle();
            }}
          >
            {theme === "dark" ? "亮色模式" : "暗色模式"}
          </button>
        </div>
      )}

      <WallpaperPicker
        open={pickerOpen}
        current={wp}
        onClose={() => setPickerOpen(false)}
        onApply={applyWallpaper}
      />
    </>
  );
}
