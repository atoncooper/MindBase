"use client";

import { useEffect, useState } from "react";
import styles from "./ClockWidget.module.css";

interface Props {
  width: number;
  height: number;
}

function handEnd(angle: number, length: number, cx: number, cy: number) {
  const rad = ((angle - 90) * Math.PI) / 180;
  return { x2: cx + Math.cos(rad) * length, y2: cy + Math.sin(rad) * length };
}

/** Analog clock widget. SVG face with hour/minute/second hands, ticks at 12 positions. */
export default function ClockWidget({ width, height }: Props) {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const size = Math.max(80, Math.min(width, height) - 8);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2;

  const sec = now.getSeconds();
  const min = now.getMinutes();
  const hr = now.getHours() % 12;
  const secAngle = sec * 6;
  const minAngle = min * 6 + sec * 0.1;
  const hrAngle = hr * 30 + min * 0.5;

  const ticks = Array.from({ length: 12 }, (_, i) => i * 30);

  return (
    <div className={styles.widget}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={cx} cy={cy} r={r - 2} className={styles.face} />
        {ticks.map((a) => {
          const rad = ((a - 90) * Math.PI) / 180;
          const inner = r - 8;
          const outer = r - 2;
          return (
            <line
              key={a}
              x1={cx + Math.cos(rad) * inner}
              y1={cy + Math.sin(rad) * inner}
              x2={cx + Math.cos(rad) * outer}
              y2={cy + Math.sin(rad) * outer}
              className={styles.tick}
            />
          );
        })}
        <line x1={cx} y1={cy} {...handEnd(hrAngle, r * 0.5, cx, cy)} className={styles.hour} />
        <line x1={cx} y1={cy} {...handEnd(minAngle, r * 0.72, cx, cy)} className={styles.minute} />
        <line x1={cx} y1={cy} {...handEnd(secAngle, r * 0.82, cx, cy)} className={styles.second} />
        <circle cx={cx} cy={cy} r={3} className={styles.center} />
      </svg>
    </div>
  );
}
