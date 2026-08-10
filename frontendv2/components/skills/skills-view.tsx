"use client";

/**
 * SkillsView - 技能商店 page shell.
 *
 * Two tabs: installed (my skills - list/upload/uninstall/preview) and store
 * (GitHub repo search + one-click install). Preview opens a right-side drawer
 * rendering the skill's SKILL.md. Apple monochrome: solid cards, hairlines,
 * rounded corners, no glass/gradient.
 */
import { useCallback, useState } from "react";
import { InstalledList } from "./installed-list";
import { StoreList } from "./store-list";
import { SkillPreviewDrawer } from "./skill-preview";
import { cn } from "@/lib/utils";

type Tab = "installed" | "store";

const SEG_SHADOW = "shadow-[0_1px_2px_rgba(0,0,0,0.10),0_0_0_0.5px_rgba(0,0,0,0.05)]";

export function SkillsView() {
    const [tab, setTab] = useState<Tab>("installed");
    const [previewId, setPreviewId] = useState<string | null>(null);
    const [installedRefresh, setInstalledRefresh] = useState(0);

    const bumpInstalled = useCallback(() => setInstalledRefresh((k) => k + 1), []);

    return (
        <div className="mx-auto max-w-[1100px] px-6 py-8 sm:px-10">
            <header className="flex items-center justify-between">
                <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
                    技能商店
                </h1>
                <div className="flex items-center gap-0.5 rounded-[10px] bg-border-subtle/70 p-0.5">
                    {(["installed", "store"] as const).map((t) => (
                        <button
                            key={t}
                            type="button"
                            onClick={() => setTab(t)}
                            className={cn(
                                "rounded-md px-3.5 py-1.5 text-[12px] font-medium transition-colors",
                                tab === t
                                    ? `bg-surface text-foreground ${SEG_SHADOW}`
                                    : "text-secondary hover:text-foreground",
                            )}
                        >
                            {t === "installed" ? "我的技能" : "技能商店"}
                        </button>
                    ))}
                </div>
            </header>

            <div className="mt-6">
                {tab === "installed" ? (
                    <InstalledList
                        refreshKey={installedRefresh}
                        onPreview={setPreviewId}
                        onChanged={bumpInstalled}
                    />
                ) : (
                    <StoreList onInstalled={bumpInstalled} />
                )}
            </div>

            <SkillPreviewDrawer
                skillId={previewId}
                onClose={() => setPreviewId(null)}
            />
        </div>
    );
}
