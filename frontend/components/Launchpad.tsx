"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import type { DockModule } from "@/lib/dock-registry";
import styles from "./Launchpad.module.css";

interface Props {
  open: boolean;
  modules: DockModule[];
  onClose: () => void;
  onLaunch: (mod: DockModule, originEl: HTMLElement) => void;
}

/**
 * macOS-style Launchpad: full-screen grid of lower-frequency dock modules.
 *
 * Styles are a CSS Module (not globals.css) so Turbopack's global CSS
 * tree-shaking cannot drop them. Renders via portal to document.body to
 * escape the .app-shell stacking context (consistent with other modals).
 *
 * Design references the loaded skills: `frontend-design` (one orchestrated
 * staggered entrance) and `apple` HIG (20pt margins, system colors, hover
 * states, respect prefers-reduced-motion).
 */
export default function Launchpad({ open, modules, onClose, onLaunch }: Props) {
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? modules.filter((m) =>
        m.title.toLowerCase().includes(query.trim().toLowerCase())
      )
    : modules;

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="launchpad-overlay"
          className={styles.overlay}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={(e) => {
            // Only close when the backdrop itself is clicked, not when the
            // click bubbles up from a child (icon/search).
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <input
            className={styles.search}
            type="text"
            placeholder="搜索..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            aria-label="搜索启动台"
          />
          <div className={styles.grid} onClick={(e) => e.stopPropagation()}>
            {filtered.map((mod, index) => {
              const Icon = mod.icon;
              return (
                <motion.button
                  key={mod.id}
                  className={styles.item}
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  transition={{
                    delay: index * 0.03,
                    type: "spring",
                    stiffness: 260,
                    damping: 24,
                  }}
                  onClick={(e) => onLaunch(mod, e.currentTarget)}
                >
                  <span className={styles.itemIcon}>
                    <Icon className="w-10 h-10" />
                  </span>
                  <span className={styles.itemLabel}>{mod.title}</span>
                </motion.button>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
