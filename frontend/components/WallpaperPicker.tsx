"use client";

import { useEffect, useState } from "react";
import {
  wallpaperApi,
  type PresetWallpaper,
  type WallpaperPref,
} from "@/lib/api";

interface Props {
  open: boolean;
  current: WallpaperPref;
  onClose: () => void;
  onApply: (wp: WallpaperPref) => void;
}

/**
 * Wallpaper picker modal: preset thumbnails (image + video) + custom upload.
 *
 * Selecting a preset or uploading calls the backend (which updates the
 * user_preferences row and cleans up the previous custom object), then
 * propagates the new preference up via onApply.
 */
export default function WallpaperPicker({
  open,
  current,
  onClose,
  onApply,
}: Props) {
  const [presets, setPresets] = useState<PresetWallpaper[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    wallpaperApi
      .presets()
      .then((r) => setPresets(r.presets))
      .catch(() => setPresets([]));
  }, [open]);

  if (!open) return null;

  const selectPreset = async (id: string) => {
    setError(null);
    try {
      const res = await wallpaperApi.selectPreset(id);
      onApply(res.wallpaper);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const res = await wallpaperApi.upload(file);
      onApply(res.wallpaper);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const presetThumb = (p: PresetWallpaper) =>
    p.type === "video"
      ? `/wallpapers/presets/${p.id}.mp4#t=0.1`
      : `/wallpapers/presets/${p.id}.jpg`;

  return (
    <div className="wallpaper-picker-overlay" onClick={onClose}>
      <div
        className="wallpaper-picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="更换壁纸"
      >
        <div className="picker-header">
          <h3>更换壁纸</h3>
          <button
            type="button"
            className="picker-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="picker-grid">
          {presets.map((p) => {
            const isActive = current.source === "preset" && current.key === p.id;
            return (
              <button
                type="button"
                key={p.id}
                className={`picker-thumb${isActive ? " is-active" : ""}`}
                onClick={() => selectPreset(p.id)}
              >
                {p.type === "video" ? (
                  <video
                    src={presetThumb(p)}
                    muted
                    preload="metadata"
                    playsInline
                    draggable={false}
                  />
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={presetThumb(p)} alt={p.name} draggable={false} />
                )}
                <span className="picker-thumb-label">{p.name}</span>
              </button>
            );
          })}
        </div>

        <div className="picker-upload">
          <label className={`picker-upload-btn${uploading ? " is-busy" : ""}`}>
            {uploading ? "上传中…" : "上传自定义壁纸"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,video/mp4"
              hidden
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = "";
              }}
            />
          </label>
          {current.source === "custom" && (
            <span className="picker-current">当前：自定义壁纸</span>
          )}
        </div>

        {error && <div className="picker-error">{error}</div>}
      </div>
    </div>
  );
}
