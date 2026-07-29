"use client";

import { useEffect, useState } from "react";
import styles from "./DateWidget.module.css";

interface Props {
  width: number;
  height: number;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const MONTHS = [
  "一", "二", "三", "四", "五", "六",
  "七", "八", "九", "十", "十一", "十二",
];

/** ISO week number (1-53). */
function getWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  return (
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7
    )
  );
}

/**
 * Date widget content. Fills its DesktopWidget container; the day numeral
 * scales with height so the widget is readable at any size the user resizes
 * to. Positioning/sizing/drag/resize are handled by DesktopWidget.
 */
export default function DateWidget({ width: _width, height }: Props) {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const day = now.getDate();
  const weekday = "星期" + WEEKDAYS[now.getDay()];
  const weekNum = getWeekNumber(now);
  const month = MONTHS[now.getMonth()] + "月";
  const year = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");

  // Scale the day numeral with container height, clamped to a sane range.
  const daySize = Math.max(36, Math.min(104, height * 0.34));
  const pad = Math.max(10, Math.round(height * 0.07));

  return (
    <div className={styles.widget} style={{ padding: `${pad}px` }}>
      <div className={styles.topline}>
        <span className={styles.weekday}>{weekday}</span>
        <span className={styles.weeknum}>WK {String(weekNum).padStart(2, "0")}</span>
      </div>
      <div className={styles.rule} />
      <div className={styles.day} style={{ fontSize: `${daySize}px` }}>
        {day}
      </div>
      <div className={styles.monthYear}>
        {month} · {year}
      </div>
      <div className={styles.rule} />
      <div className={styles.time}>
        {hh}
        <span className={styles.colon}>:</span>
        {mm}
        <span className={styles.seconds}>{ss}</span>
      </div>
    </div>
  );
}
