"use client";

import { ComponentType } from "react";

export interface DockPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export interface DockModule {
  id: string;
  icon: ComponentType<{ className?: string }>;
  title: string;
  panel: ComponentType<DockPanelProps>;
  defaultSize?: { width: number; height: number };
  defaultPosition?: { x: number; y: number };
}

const registry = new Map<string, DockModule>();

export function registerDockModule(mod: DockModule): void {
  if (registry.has(mod.id)) {
    console.warn(`[Dock] module "${mod.id}" already registered, overwriting`);
  }
  registry.set(mod.id, mod);
}

export function getDockModules(): DockModule[] {
  return Array.from(registry.values());
}

export function getDockModule(id: string): DockModule | undefined {
  return registry.get(id);
}
