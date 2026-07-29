"use client";

import { useState } from "react";
import styles from "./CalendarWidget.module.css";

interface Props {
  width: number;
  height: number;
}

const MONTHS = [
  "1月", "2月", "3月", "4月", "5月", "6月",
  "7月", "8月", "9月", "10月", "11月", "12月",
];
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/** Month calendar widget. Highlights today; ‹/› switch months. */
export default function CalendarWidget({ width: _w, height: _h }: Props) {
  const today = new Date();
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });

  const startDay = new Date(view.y, view.m, 1).getDay();
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);

  const isToday = (d: number) =>
    d === today.getDate() &&
    view.m === today.getMonth() &&
    view.y === today.getFullYear();

  const shift = (delta: number) =>
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  return (
    <div className={styles.widget}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.nav}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => shift(-1)}
          aria-label="上个月"
        >
          ‹
        </button>
        <span className={styles.title}>
          {view.y}年 {MONTHS[view.m]}
        </span>
        <button
          type="button"
          className={styles.nav}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => shift(1)}
          aria-label="下个月"
        >
          ›
        </button>
      </div>
      <div className={styles.weekrow}>
        {WEEK.map((w) => (
          <div key={w} className={styles.weekday}>
            {w}
          </div>
        ))}
      </div>
      <div className={styles.grid}>
        {cells.map((d, i) => (
          <div
            key={i}
            className={`${styles.day} ${d && isToday(d) ? styles.today : ""} ${
              d ? "" : styles.empty
            }`}
          >
            {d ?? ""}
          </div>
        ))}
      </div>
    </div>
  );
}
