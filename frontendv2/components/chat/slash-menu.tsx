"use client";

/**
 * SlashMenu - Codex-style command bar triggered by "/" in the chat input.
 *
 * Two groups of entries:
 *   - 命令: built-in actions (quiz-from-summary opens the wizard dialog)
 *   - Skills: installed skills, multi-select — selected ones are force-injected
 *     into the next message's system prompt (Claude-Code-style skill usage)
 *
 * The parent (chat-input) owns the open/filter/activeIndex state and the
 * keyboard handling; this component is presentational + mouse interaction.
 * onMouseDown preventDefault keeps textarea focus when clicking items.
 */
import { motion, AnimatePresence } from "framer-motion";
import { GraduationCap, Check, Puzzle } from "lucide-react";
import type { InstalledSkill } from "@/lib/api";
import { cn } from "@/lib/utils";

export const SLASH_COMMANDS = [
    {
        id: "quiz-from-summary",
        label: "生成题目",
        hint: "基于当前会话总结生成练习题",
    },
] as const;

export interface SlashItem {
    key: string;
    kind: "command" | "skill";
    commandId?: string;
    skill?: InstalledSkill;
    label: string;
    hint?: string;
}

/** Shared item builder — keyboard nav in chat-input must mirror rendering. */
export function buildSlashItems(filter: string, skills: InstalledSkill[]): SlashItem[] {
    const q = filter.trim().toLowerCase();
    const commands = SLASH_COMMANDS.filter(
        (c) =>
            !q ||
            c.label.toLowerCase().includes(q) ||
            c.hint.toLowerCase().includes(q),
    );
    const matchedSkills = skills.filter(
        (s) =>
            !q ||
            s.name.toLowerCase().includes(q) ||
            (s.description ?? "").toLowerCase().includes(q),
    );
    return [
        ...commands.map((c) => ({
            key: c.id,
            kind: "command" as const,
            commandId: c.id,
            label: c.label,
            hint: c.hint,
        })),
        ...matchedSkills.map((s) => ({
            key: s.skill_id,
            kind: "skill" as const,
            skill: s,
            label: s.name,
            hint: s.description ?? undefined,
        })),
    ];
}

export interface SlashMenuProps {
    open: boolean;
    filter: string;
    skills: InstalledSkill[];
    selectedSkillIds: string[];
    activeIndex: number;
    onActiveIndexChange: (index: number) => void;
    onPickCommand: (id: string) => void;
    onToggleSkill: (skill: InstalledSkill) => void;
}

export function SlashMenu({
    open,
    filter,
    skills,
    selectedSkillIds,
    activeIndex,
    onActiveIndexChange,
    onPickCommand,
    onToggleSkill,
}: SlashMenuProps) {
    const items = buildSlashItems(filter, skills);
    const commands = items.filter((i) => i.kind === "command");
    const skillItems = items.filter((i) => i.kind === "skill");

    return (
        <AnimatePresence>
            {open && items.length > 0 && (
                <motion.div
                    initial={{ opacity: 0, y: 6, scale: 0.99 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.99 }}
                    transition={{ duration: 0.16, ease: [0.28, 0.11, 0.32, 1] }}
                    className="absolute bottom-full left-0 right-0 z-40 mb-2 overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_8px_32px_rgba(0,0,0,0.12)]"
                    role="listbox"
                    aria-label="命令与技能菜单"
                >
                    {commands.length > 0 && (
                        <MenuGroup label="命令">
                            {commands.map((c) => (
                                <MenuRow
                                    key={c.key}
                                    active={items.indexOf(c) === activeIndex}
                                    onMouseEnter={() => onActiveIndexChange(items.indexOf(c))}
                                    onClick={() => c.commandId && onPickCommand(c.commandId)}
                                    icon={<GraduationCap className="h-4 w-4 shrink-0 text-secondary" />}
                                    label={c.label}
                                    hint={c.hint}
                                />
                            ))}
                        </MenuGroup>
                    )}

                    {skillItems.length > 0 && (
                        <MenuGroup label="Skills">
                            {skillItems.map((s) => {
                                const idx = items.indexOf(s);
                                const selected = selectedSkillIds.includes(s.key);
                                return (
                                    <MenuRow
                                        key={s.key}
                                        active={idx === activeIndex}
                                        onMouseEnter={() => onActiveIndexChange(idx)}
                                        onClick={() => s.skill && onToggleSkill(s.skill)}
                                        icon={<Puzzle className="h-4 w-4 shrink-0 text-secondary" />}
                                        label={s.label}
                                        hint={s.hint}
                                        trailing={
                                            selected ? (
                                                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground text-surface">
                                                    <Check className="h-3 w-3" />
                                                </span>
                                            ) : undefined
                                        }
                                    />
                                );
                            })}
                        </MenuGroup>
                    )}

                    <div className="border-t border-border-subtle px-3 py-1.5 text-[11px] text-tertiary">
                        <kbd className="font-sans">↑↓</kbd> 选择 ·{" "}
                        <kbd className="font-sans">⏎</kbd> 确认 ·{" "}
                        <kbd className="font-sans">Esc</kbd> 关闭 · Skills 可多选，随下条消息注入
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

function MenuGroup({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="py-1">
            <div className="px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-tertiary">
                {label}
            </div>
            {children}
        </div>
    );
}

interface MenuRowProps {
    active: boolean;
    onMouseEnter: () => void;
    onClick: () => void;
    icon: React.ReactNode;
    label: string;
    hint?: string;
    trailing?: React.ReactNode;
}

function MenuRow({ active, onMouseEnter, onClick, icon, label, hint, trailing }: MenuRowProps) {
    return (
        <button
            type="button"
            role="option"
            aria-selected={active}
            // Keep textarea focus so keyboard nav continues after mouse hover.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={onMouseEnter}
            onClick={onClick}
            className={cn(
                "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
                active ? "bg-border-subtle" : "bg-transparent",
            )}
        >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border-subtle bg-background">
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">
                    {label}
                </span>
                {hint && (
                    <span className="block truncate text-[11px] text-tertiary">{hint}</span>
                )}
            </span>
            {trailing}
        </button>
    );
}
