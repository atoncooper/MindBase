"use client";

import { Plus } from "lucide-react";
import { CredentialCard, type DisplayItem } from "./credential-card";

interface Props {
    title: string;
    description: string;
    items: DisplayItem[];
    loading: boolean;
    testingIds: Set<number>;
    onAdd: () => void;
    onEdit: (item: DisplayItem) => void;
    onDelete: (item: DisplayItem) => void;
    onSetDefault: (item: DisplayItem) => void;
    onTest: (item: DisplayItem) => void;
}

export function ConfigSection({
    title,
    description,
    items,
    loading,
    testingIds,
    onAdd,
    onEdit,
    onDelete,
    onSetDefault,
    onTest,
}: Props) {
    return (
        <section className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
            <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
                <div className="min-w-0">
                    <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                        {title}
                    </h2>
                    <p className="mt-0.5 text-[12px] text-secondary">{description}</p>
                </div>
                <button
                    type="button"
                    onClick={onAdd}
                    className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border px-3 text-[12px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                >
                    <Plus className="h-3.5 w-3.5" />
                    新增
                </button>
            </div>

            <div className="p-4">
                {loading ? (
                    <p className="py-8 text-center text-[13px] text-tertiary">加载中…</p>
                ) : items.length === 0 ? (
                    <div className="py-8 text-center">
                        <p className="text-[13px] text-secondary">暂未配置</p>
                        <p className="mt-1 text-[12px] text-tertiary">
                            点击&ldquo;新增&rdquo;添加配置
                        </p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {items.map((item) => (
                            <CredentialCard
                                key={item.id}
                                item={item}
                                testing={testingIds.has(item.id)}
                                onTest={() => onTest(item)}
                                onEdit={() => onEdit(item)}
                                onSetDefault={() => onSetDefault(item)}
                                onDelete={() => onDelete(item)}
                            />
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}
