"use client";

/**
 * 新建研究项目弹窗：标题必填，成果类型/领域/目标期刊/截止日期可选。
 * 提交成功后把后端返回的 ProjectDetail 交给父组件，由父组件选中新项目。
 *
 * 表单 body 只在弹窗打开时挂载（Modal 内部条件渲染），因此每次打开都是新状态。
 */
import { useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { academicApi, type AcademicPaperType, type AcademicProjectDetail } from "@/lib/api";
import { ErrorBanner, Modal, PAPER_TYPE_LABELS } from "./research-ui";

const PAPER_TYPES: AcademicPaperType[] = ["journal", "thesis", "fund"];

export function NewProjectDialog({
    open,
    onClose,
    onCreated,
}: {
    open: boolean;
    onClose: () => void;
    onCreated: (detail: AcademicProjectDetail) => void;
}) {
    return (
        <Modal open={open} title="新建研究项目" icon={FlaskConical} onClose={onClose}>
            <NewProjectBody onClose={onClose} onCreated={onCreated} />
        </Modal>
    );
}

function NewProjectBody({
    onClose,
    onCreated,
}: {
    onClose: () => void;
    onCreated: (detail: AcademicProjectDetail) => void;
}) {
    const [title, setTitle] = useState("");
    const [paperType, setPaperType] = useState<AcademicPaperType>("journal");
    const [field, setField] = useState("");
    const [targetJournal, setTargetJournal] = useState("");
    const [deadline, setDeadline] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const disabled = submitting || !title.trim();

    async function submit() {
        if (disabled) return;
        setSubmitting(true);
        setError(null);
        try {
            const detail = await academicApi.createProject({
                title: title.trim(),
                paperType,
                field: field.trim() || undefined,
                targetJournal: targetJournal.trim() || undefined,
                deadline: deadline || undefined,
            });
            onCreated(detail);
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : "创建失败");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="space-y-4">
            {error && <ErrorBanner message={error} />}

            <div>
                <label className="mb-1.5 block text-[13px] font-medium text-secondary">
                    项目标题 <span className="text-danger">*</span>
                </label>
                <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={120}
                    placeholder="如：基于图神经网络的推荐系统综述"
                    className="field"
                />
            </div>

            <div>
                <label className="mb-1.5 block text-[13px] font-medium text-secondary">成果类型</label>
                <div className="grid grid-cols-3 gap-2">
                    {PAPER_TYPES.map((type) => (
                        <button
                            key={type}
                            type="button"
                            onClick={() => setPaperType(type)}
                            className={cn(
                                "rounded-lg border px-2 py-2 text-[12px] font-medium transition-all",
                                paperType === type
                                    ? "border-accent bg-accent-soft text-accent"
                                    : "border-border bg-surface text-foreground hover:border-tertiary",
                            )}
                        >
                            {PAPER_TYPE_LABELS[type]}
                        </button>
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-secondary">研究领域</label>
                    <input
                        value={field}
                        onChange={(e) => setField(e.target.value)}
                        maxLength={80}
                        placeholder="如：计算机科学"
                        className="field"
                    />
                </div>
                <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-secondary">目标期刊 / 会议</label>
                    <input
                        value={targetJournal}
                        onChange={(e) => setTargetJournal(e.target.value)}
                        maxLength={120}
                        placeholder="如：NeurIPS"
                        className="field"
                    />
                </div>
            </div>

            <div>
                <label className="mb-1.5 block text-[13px] font-medium text-secondary">截止日期</label>
                <input
                    type="date"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                    className="field"
                />
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
                <button
                    type="button"
                    onClick={onClose}
                    className="rounded-full px-4 py-2 text-[13px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                >
                    取消
                </button>
                <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={disabled}
                    className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                    {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    创建项目
                </button>
            </div>
        </div>
    );
}
