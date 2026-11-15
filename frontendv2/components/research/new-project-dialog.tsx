"use client";

/**
 * 新建研究项目弹窗（MUI Dialog）：标题必填，成果类型/领域/目标期刊/截止日期
 * 可选。提交成功后把后端返回的 ProjectDetail 交给父组件，由父组件选中新项目。
 *
 * 表单 body 只在弹窗打开时挂载（Modal 内部 MUI Dialog 的条件挂载），因此每次
 * 打开都是新状态。校验/提交逻辑与原实现完全一致。
 */
import { useState } from "react";
import { Box, Button, CircularProgress, MenuItem, TextField } from "@mui/material";
import { FlaskConical } from "lucide-react";
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
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
            {error && <ErrorBanner message={error} />}

            <TextField
                label="项目标题"
                required
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="如：基于图神经网络的推荐系统综述"
                slotProps={{ htmlInput: { maxLength: 120 } }}
            />

            <TextField
                select
                label="成果类型"
                value={paperType}
                onChange={(e) => setPaperType(e.target.value as AcademicPaperType)}
            >
                {PAPER_TYPES.map((type) => (
                    <MenuItem key={type} value={type}>
                        {PAPER_TYPE_LABELS[type]}
                    </MenuItem>
                ))}
            </TextField>

            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
                <TextField
                    label="研究领域"
                    value={field}
                    onChange={(e) => setField(e.target.value)}
                    placeholder="如：计算机科学"
                    slotProps={{ htmlInput: { maxLength: 80 } }}
                />
                <TextField
                    label="目标期刊 / 会议"
                    value={targetJournal}
                    onChange={(e) => setTargetJournal(e.target.value)}
                    placeholder="如：NeurIPS"
                    slotProps={{ htmlInput: { maxLength: 120 } }}
                />
            </Box>

            <TextField
                label="截止日期"
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
            />

            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 1, pt: 0.5 }}>
                <Button color="inherit" onClick={onClose} disabled={submitting}>
                    取消
                </Button>
                <Button
                    variant="contained"
                    onClick={() => void submit()}
                    disabled={disabled}
                    startIcon={submitting ? <CircularProgress size={14} color="inherit" /> : undefined}
                >
                    {submitting ? "创建中…" : "创建项目"}
                </Button>
            </Box>
        </Box>
    );
}
