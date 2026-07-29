import type { ComponentType } from "react";

/** Props every widget component receives - it fills its container. */
export interface WidgetComponentProps {
  width: number;
  height: number;
}

/** Definition of a widget type that lives in the library. */
export interface WidgetType {
  type: string;
  name: string;
  icon: string; // emoji for the library grid
  component: ComponentType<WidgetComponentProps>;
  defaultSize: { width: number; height: number };
  minSize: { width: number; height: number };
}

/** A widget instance placed on the desktop. Persisted to localStorage. */
export interface WidgetInstance {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Lazy import avoids a cycle when the registry is consumed by page.tsx while
// DateWidget itself imports nothing from the registry.
import DateWidget from "@/components/DateWidget";
import ClockWidget from "@/components/ClockWidget";
import CalendarWidget from "@/components/CalendarWidget";
import TodoWidget from "@/components/TodoWidget";
import StickyNoteWidget from "@/components/StickyNoteWidget";

export const widgetRegistry: WidgetType[] = [
  {
    type: "date",
    name: "日期",
    icon: "📅",
    component: DateWidget,
    defaultSize: { width: 220, height: 250 },
    minSize: { width: 160, height: 190 },
  },
  {
    type: "clock",
    name: "时钟",
    icon: "🕐",
    component: ClockWidget,
    defaultSize: { width: 200, height: 200 },
    minSize: { width: 120, height: 120 },
  },
  {
    type: "calendar",
    name: "日历",
    icon: "🗓️",
    component: CalendarWidget,
    defaultSize: { width: 240, height: 260 },
    minSize: { width: 180, height: 200 },
  },
  {
    type: "todo",
    name: "待办",
    icon: "✅",
    component: TodoWidget,
    defaultSize: { width: 240, height: 280 },
    minSize: { width: 180, height: 200 },
  },
  {
    type: "sticky",
    name: "便签",
    icon: "📝",
    component: StickyNoteWidget,
    defaultSize: { width: 240, height: 240 },
    minSize: { width: 160, height: 160 },
  },
];

export function getWidgetType(type: string): WidgetType | undefined {
  return widgetRegistry.find((w) => w.type === type);
}
