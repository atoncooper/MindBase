"use client";

import { createPortal } from "react-dom";
import { widgetRegistry } from "@/lib/widget-registry";
import styles from "./WidgetLibrary.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  onAdd: (type: string) => void;
}

/**
 * Widget library picker: shows all registered widget types. Clicking one
 * adds an instance to the desktop at a default offset position. Portaled to
 * body to escape the app-shell stacking context (consistent with other
 * modals).
 */
export default function WidgetLibrary({ open, onClose, onAdd }: Props) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.panel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="桌面组件库"
      >
        <div className={styles.header}>
          <h3>桌面组件</h3>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <div className={styles.grid}>
          {widgetRegistry.map((w) => (
            <button
              type="button"
              key={w.type}
              className={styles.item}
              onClick={() => {
                onAdd(w.type);
                onClose();
              }}
            >
              <span className={styles.icon}>{w.icon}</span>
              <span className={styles.name}>{w.name}</span>
              <span className={styles.hint}>
                {w.defaultSize.width}×{w.defaultSize.height}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
