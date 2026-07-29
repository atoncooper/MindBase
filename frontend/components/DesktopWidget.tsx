"use client";

import { motion, useDragControls } from "framer-motion";
import { useState } from "react";
import { getWidgetType, type WidgetInstance } from "@/lib/widget-registry";
import styles from "./DesktopWidget.module.css";

interface Props {
  instance: WidgetInstance;
  onChange: (id: string, patch: Partial<WidgetInstance>) => void;
  onRemove: (id: string) => void;
}

/**
 * Container for a desktop widget instance. Owns positioning (drag), sizing
 * (bottom-right resize handle), and removal. Renders the widget component
 * from the registry, filling the container.
 */
export default function DesktopWidget({ instance, onChange, onRemove }: Props) {
  const wt = getWidgetType(instance.type);
  const [resizing, setResizing] = useState(false);
  const dragControls = useDragControls();
  if (!wt) return null;
  const Component = wt.component;

  const handleDragEnd = (_: unknown, info: { offset: { x: number; y: number } }) => {
    const next = {
      x: Math.max(0, Math.min(instance.x + info.offset.x, window.innerWidth - 60)),
      y: Math.max(0, Math.min(instance.y + info.offset.y, window.innerHeight - 60)),
    };
    onChange(instance.id, next);
  };

  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = instance.width;
    const startH = instance.height;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(wt.minSize.width, startW + ev.clientX - startX);
      const h = Math.max(wt.minSize.height, startH + ev.clientY - startY);
      onChange(instance.id, { width: w, height: h });
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <motion.div
      className={styles.container}
      style={{ width: instance.width, height: instance.height }}
      initial={{ x: instance.x, y: instance.y }}
      animate={{ x: instance.x, y: instance.y }}
      drag
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      dragElastic={0}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      onDragEnd={handleDragEnd}
      whileHover={{ scale: 1.01 }}
      whileTap={{ scale: 0.99 }}
    >
      <div
        className={styles.content}
        onPointerDown={(e) => dragControls.start(e)}
      >
        <Component width={instance.width} height={instance.height} />
      </div>
      <button
        type="button"
        className={styles.remove}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(instance.id);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="移除组件"
      >
        ×
      </button>
      <div
        className={styles.resize}
        onPointerDown={startResize}
        aria-label="调整大小"
      />
    </motion.div>
  );
}
