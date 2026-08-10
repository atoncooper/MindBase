"use client";

import { motion } from "framer-motion";

/**
 * Animated visual - the "下方动画展示" area.
 *
 * Apple-minimal: monochrome floating orbs over a faint grid, with a single
 * Apple-blue accent. Purely decorative, no data. Designed to sit below the nav
 * on both the landing page and the logged-in dashboard.
 */
export function AnimatedVisual() {
  return (
    <div className="pointer-events-none relative h-[420px] w-full overflow-hidden">
      {/* Faint grid */}
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(0,0,0,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.04) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
        }}
      />

      {/* Floating orbs */}
      <motion.div
        className="absolute left-[12%] top-[18%] h-40 w-40 rounded-full"
        style={{
          background: "radial-gradient(circle at 30% 30%, #1d1d1f, #6e6e73)",
          filter: "blur(2px)",
        }}
        animate={{ y: [0, -26, 0], x: [0, 12, 0] }}
        transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute right-[16%] top-[28%] h-28 w-28 rounded-full"
        style={{
          background: "radial-gradient(circle at 30% 30%, #ffffff, #d2d2d7)",
          boxShadow: "0 10px 40px rgba(0,0,0,0.08)",
        }}
        animate={{ y: [0, 22, 0], x: [0, -14, 0] }}
        transition={{ duration: 11, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute left-[42%] bottom-[14%] h-24 w-24 rounded-full"
        style={{
          background: "radial-gradient(circle at 30% 30%, #0071e3, #0046a0)",
          filter: "blur(1px)",
        }}
        animate={{ y: [0, -18, 0], x: [0, 10, 0] }}
        transition={{ duration: 7.5, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute right-[34%] bottom-[24%] h-16 w-16 rounded-full border border-border"
        style={{ background: "rgba(255,255,255,0.6)" }}
        animate={{ y: [0, 16, 0], x: [0, -8, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Soft radial glow */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 60%, rgba(0,113,227,0.06), transparent 70%)",
        }}
      />
    </div>
  );
}
