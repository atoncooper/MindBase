"use client";

import { useState, useEffect } from "react";
import styles from "./StickyNoteWidget.module.css";

interface Props {
  width: number;
  height: number;
}
const KEY = "widget_sticky";

/** Sticky note widget. Free text, persists to localStorage. Header is the
 * drag handle; the textarea stops pointer-down so typing doesn't drag. */
export default function StickyNoteWidget({ width: _w, height: _h }: Props) {
  const [text, setText] = useState("");

  useEffect(() => {
    const stored = localStorage.getItem(KEY);
    if (stored) setText(stored);
  }, []);

  const onChange = (v: string) => {
    setText(v);
    localStorage.setItem(KEY, v);
  };

  return (
    <div className={styles.widget}>
      <div className={styles.header}>便签</div>
      <textarea
        className={styles.textarea}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        placeholder="记点什么..."
      />
    </div>
  );
}
