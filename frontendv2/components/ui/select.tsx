"use client";

/**
 * Select — the app-wide styled replacement for native <select>.
 *
 * Trigger + animated dropdown menu (same interaction pattern as the cloud
 * toolbar's sort menu): outside-click close, Escape/ArrowUp/ArrowDown/Enter
 * keyboard support, check mark on the selected option.
 *
 * Props mirror the native control (value / onChange(value)) so swaps are
 * mechanical. Menu width follows the trigger.
 */
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
    value: string;
    label: string;
}

interface SelectProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    /** shown when value is "" and no option carries that value */
    placeholder?: string;
    disabled?: boolean;
    /** full-width trigger (default) */
    className?: string;
    ariaLabel?: string;
}

export function Select({
    value,
    onChange,
    options,
    placeholder = "请选择",
    disabled = false,
    className,
    ariaLabel,
}: SelectProps) {
    const [open, setOpen] = useState(false);
    const [activeIdx, setActiveIdx] = useState(-1);
    const rootRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const selected = options.find((o) => o.value === value);

    // Outside click closes.
    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
    }, [open]);

    // Keep the active option in view while keyboard-navigating.
    useEffect(() => {
        if (!open || activeIdx < 0) return;
        menuRef.current
            ?.querySelector(`[data-option-idx="${activeIdx}"]`)
            ?.scrollIntoView({ block: "nearest" });
    }, [open, activeIdx]);

    const openMenu = () => {
        if (disabled) return;
        const idx = options.findIndex((o) => o.value === value);
        setActiveIdx(idx >= 0 ? idx : 0);
        setOpen(true);
    };

    const commit = (idx: number) => {
        const opt = options[idx];
        if (!opt) return;
        onChange(opt.value);
        setOpen(false);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (disabled) return;
        switch (e.key) {
            case "Enter":
            case " ":
                if (open) {
                    if (activeIdx >= 0) {
                        e.preventDefault();
                        commit(activeIdx);
                    }
                } else {
                    e.preventDefault();
                    openMenu();
                }
                break;
            case "Escape":
                if (open) {
                    e.preventDefault();
                    setOpen(false);
                }
                break;
            case "ArrowDown":
                e.preventDefault();
                if (!open) {
                    openMenu();
                } else {
                    setActiveIdx((i) => Math.min(i + 1, options.length - 1));
                }
                break;
            case "ArrowUp":
                e.preventDefault();
                if (!open) {
                    openMenu();
                } else {
                    setActiveIdx((i) => Math.max(i - 1, 0));
                }
                break;
        }
    };

    return (
        <div ref={rootRef} className={cn("relative", className)}>
            <button
                type="button"
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? "select-menu" : undefined}
                aria-label={ariaLabel}
                disabled={disabled}
                onClick={() => (open ? setOpen(false) : openMenu())}
                onKeyDown={onKeyDown}
                className={cn(
                    "flex h-9 w-full items-center justify-between gap-2 rounded-lg border bg-background px-3 text-left text-[13px] outline-none transition-colors",
                    open
                        ? "border-accent"
                        : "border-border hover:border-secondary/60",
                    disabled && "cursor-not-allowed opacity-50"
                )}
            >
                <span
                    className={cn(
                        "min-w-0 truncate",
                        selected ? "text-foreground" : "text-tertiary"
                    )}
                >
                    {selected ? selected.label : placeholder}
                </span>
                <ChevronDown
                    className={cn(
                        "h-3.5 w-3.5 shrink-0 text-tertiary transition-transform duration-200",
                        open && "rotate-180 text-accent"
                    )}
                />
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        id="select-menu"
                        ref={menuRef}
                        role="listbox"
                        initial={{ opacity: 0, y: -4, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -4, scale: 0.98 }}
                        transition={{ duration: 0.14 }}
                        className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-[0_8px_28px_rgba(0,0,0,0.12)]"
                    >
                        {options.map((opt, idx) => {
                            const isSelected = opt.value === value;
                            return (
                                <button
                                    key={opt.value}
                                    type="button"
                                    role="option"
                                    aria-selected={isSelected}
                                    data-option-idx={idx}
                                    onMouseEnter={() => setActiveIdx(idx)}
                                    onClick={() => commit(idx)}
                                    className={cn(
                                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] transition-colors",
                                        idx === activeIdx
                                            ? "bg-border-subtle/70"
                                            : "hover:bg-border-subtle/50",
                                        isSelected
                                            ? "font-medium text-accent"
                                            : "text-foreground"
                                    )}
                                >
                                    <span className="min-w-0 truncate">{opt.label}</span>
                                    {isSelected && (
                                        <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                                    )}
                                </button>
                            );
                        })}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
