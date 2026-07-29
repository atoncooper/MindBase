"use client";

import { useState, useEffect } from "react";
import styles from "./TodoWidget.module.css";

interface Props {
  width: number;
  height: number;
}
interface Todo {
  id: string;
  text: string;
  done: boolean;
}
const KEY = "widget_todos";

/** Reminders-style todo list. Persists to localStorage. The header is the
 * drag handle; input + list stop pointer-down so typing/clicking doesn't drag. */
export default function TodoWidget({ width: _w, height: _h }: Props) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    const stored = localStorage.getItem(KEY);
    if (stored) {
      try {
        setTodos(JSON.parse(stored));
      } catch {}
    }
  }, []);

  const persist = (next: Todo[]) => {
    setTodos(next);
    localStorage.setItem(KEY, JSON.stringify(next));
  };
  const add = () => {
    const t = input.trim();
    if (!t) return;
    persist([...todos, { id: String(Date.now()), text: t, done: false }]);
    setInput("");
  };
  const toggle = (id: string) =>
    persist(todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const remove = (id: string) => persist(todos.filter((t) => t.id !== id));

  return (
    <div className={styles.widget}>
      <div className={styles.header}>待办</div>
      <div className={styles.inputRow} onPointerDown={(e) => e.stopPropagation()}>
        <input
          className={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="添加待办..."
        />
        <button type="button" className={styles.addBtn} onClick={add} aria-label="添加">
          +
        </button>
      </div>
      <div className={styles.list} onPointerDown={(e) => e.stopPropagation()}>
        {todos.map((t) => (
          <div key={t.id} className={`${styles.item} ${t.done ? styles.done : ""}`}>
            <button
              type="button"
              className={styles.checkbox}
              onClick={() => toggle(t.id)}
              aria-label="标记完成"
            >
              {t.done ? "✓" : ""}
            </button>
            <span className={styles.text}>{t.text}</span>
            <button
              type="button"
              className={styles.del}
              onClick={() => remove(t.id)}
              aria-label="删除"
            >
              ×
            </button>
          </div>
        ))}
        {todos.length === 0 && <div className={styles.empty}>暂无待办</div>}
      </div>
    </div>
  );
}
