"use client";

/**
 * 概览 Tab 的 Autopilot 卡片：用 MUI 组件组合，展示/配置项目自动推进。
 * 只做确定性动作（门禁同步/自动推进/建议通知），不调用模型。
 */
import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CardHeader from "@mui/material/CardHeader";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { Loader2, PauseCircle, PlayCircle, RefreshCw, Sparkles } from "lucide-react";
import {
    academicApi,
    type AcademicAutopilotMode,
    type AcademicAutopilotSetting,
} from "@/lib/api";
import { formatDateTime } from "./research-ui";

const AUTOPILOT_MODE_OPTIONS: Array<{ value: AcademicAutopilotMode; label: string; hint: string }> = [
    { value: "off", label: "关闭", hint: "不自动运行，只保留手动检查。" },
    { value: "assist", label: "建议", hint: "定时生成下一步建议通知，不推进阶段。" },
    { value: "auto", label: "自动", hint: "门禁就绪时自动推进到「待确认」，approved 仍由你确认。" },
];

export function AutopilotCard({ projectId }: { projectId: string }) {
    const [setting, setSetting] = useState<AcademicAutopilotSetting | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [budgetDraft, setBudgetDraft] = useState("10");

    const load = useCallback(async () => {
        try {
            const next = await academicApi.getAutopilot(projectId);
            setSetting(next);
            setBudgetDraft(String(next.maxActionsPerDay));
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载自动推进设置失败");
        }
    }, [projectId]);

    useEffect(() => {
        /* eslint-disable-next-line react-hooks/set-state-in-effect -- initial autopilot fetch */
        void load();
    }, [load]);

    const save = async (patch: {
        mode?: AcademicAutopilotMode;
        maxActionsPerDay?: number;
        stopped?: boolean;
    }) => {
        setBusy("save");
        setError(null);
        setNotice(null);
        try {
            const next = await academicApi.patchAutopilot(projectId, patch);
            setSetting(next);
            setBudgetDraft(String(next.maxActionsPerDay));
            setNotice("设置已保存");
        } catch (e) {
            setError(e instanceof Error ? e.message : "保存自动推进设置失败");
        } finally {
            setBusy(null);
        }
    };

    const tick = async () => {
        setBusy("tick");
        setError(null);
        setNotice(null);
        try {
            const result = await academicApi.tickAutopilot(projectId);
            const advanced = result && (result as { advanced?: boolean }).advanced ? "，已自动推进阶段" : "";
            setNotice("已执行一次自动检查" + advanced);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "执行自动检查失败");
        } finally {
            setBusy(null);
        }
    };

    const stop = async () => {
        setBusy("stop");
        setError(null);
        try {
            setSetting(await academicApi.stopAutopilot(projectId));
            setNotice("已急停自动推进");
        } catch (e) {
            setError(e instanceof Error ? e.message : "急停失败");
        } finally {
            setBusy(null);
        }
    };

    const resume = async () => {
        setBusy("resume");
        setError(null);
        try {
            setSetting(await academicApi.resumeAutopilot(projectId));
            setNotice("已恢复自动推进");
        } catch (e) {
            setError(e instanceof Error ? e.message : "恢复失败");
        } finally {
            setBusy(null);
        }
    };

    const mode = setting?.mode ?? "off";
    const stopped = Boolean(setting?.stoppedAt);
    const modeHint = AUTOPILOT_MODE_OPTIONS.find((option) => option.value === mode)?.hint ?? "";
    const status = stopped
        ? { label: "已急停", color: "error" as const, variant: "outlined" as const }
        : mode === "off"
          ? { label: "未启用", color: "default" as const, variant: "outlined" as const }
          : mode === "auto"
            ? { label: "自动运行", color: "success" as const, variant: "filled" as const }
            : { label: "建议模式", color: "info" as const, variant: "filled" as const };

    return (
        <Card variant="outlined" sx={{ borderRadius: 2, borderColor: "divider" }}>
            <CardHeader
                avatar={
                    <Box
                        sx={{
                            width: 32,
                            height: 32,
                            borderRadius: 1,
                            display: "grid",
                            placeItems: "center",
                            bgcolor: "primary.50",
                            color: "primary.main",
                        }}
                    >
                        <Sparkles size={16} aria-hidden="true" />
                    </Box>
                }
                title={
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                            自动推进（Autopilot）
                        </Typography>
                        <Chip size="small" color={status.color} variant={status.variant} label={status.label} />
                    </Stack>
                }
                subheader="同步计划任务、门禁就绪时推进到「待确认」；不调用模型、不提交实验、不写 approved。"
                action={
                    <Stack direction="row" spacing={2} sx={{ pt: 0.5 }}>
                        <Box>
                            <Typography variant="caption" color="text.secondary">
                                今日动作
                            </Typography>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                {setting?.actionsToday ?? 0}
                                <Typography component="span" variant="caption" color="text.secondary">
                                    /{setting?.maxActionsPerDay ?? 10}
                                </Typography>
                            </Typography>
                        </Box>
                        <Divider orientation="vertical" flexItem />
                        <Box>
                            <Typography variant="caption" color="text.secondary">
                                上次检查
                            </Typography>
                            <Typography variant="body2">
                                {setting?.lastTickAt ? formatDateTime(setting.lastTickAt) : "—"}
                            </Typography>
                        </Box>
                    </Stack>
                }
                sx={{
                    "& .MuiCardHeader-content": { minWidth: 0 },
                    "& .MuiCardHeader-action": { alignSelf: "center", m: 0 },
                    "& .MuiCardHeader-subheader": { mt: 0.25 },
                }}
            />
            <CardContent sx={{ pt: 0, "&:last-child": { pb: 2 } }}>
                <Stack spacing={2}>
                    {error && (
                        <Alert
                            severity="error"
                            onClose={() => setError(null)}
                            action={
                                <Button color="inherit" size="small" onClick={() => void load()}>
                                    重试
                                </Button>
                            }
                        >
                            {error}
                        </Alert>
                    )}
                    {notice && (
                        <Alert severity="success" onClose={() => setNotice(null)}>
                            {notice}
                        </Alert>
                    )}

                    <Stack
                        direction={{ xs: "column", lg: "row" }}
                        spacing={2}
                        sx={{ alignItems: { lg: "center" } }}
                    >
                        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", flexWrap: "wrap" }}>
                            <Typography variant="body2" color="text.secondary">
                                模式
                            </Typography>
                            <ToggleButtonGroup
                                exclusive
                                size="small"
                                value={mode}
                                disabled={busy !== null}
                                onChange={(_event, next: AcademicAutopilotMode | null) => {
                                    if (next && next !== mode) void save({ mode: next });
                                }}
                            >
                                {AUTOPILOT_MODE_OPTIONS.map((option) => (
                                    <ToggleButton key={option.value} value={option.value} sx={{ px: 2 }}>
                                        {option.label}
                                    </ToggleButton>
                                ))}
                            </ToggleButtonGroup>
                            <Typography variant="caption" color="text.secondary">
                                {modeHint}
                            </Typography>
                        </Stack>

                        <Divider orientation="vertical" flexItem sx={{ display: { xs: "none", lg: "block" } }} />

                        <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
                            <TextField
                                label="每日上限"
                                type="number"
                                size="small"
                                value={budgetDraft}
                                disabled={busy !== null}
                                onChange={(event) => setBudgetDraft(event.target.value)}
                                slotProps={{ htmlInput: { min: 1, max: 100 } }}
                                sx={{ width: 110 }}
                            />
                            <Button
                                size="small"
                                variant="outlined"
                                disabled={busy !== null || Number(budgetDraft) === (setting?.maxActionsPerDay ?? 10)}
                                onClick={() => {
                                    const value = Number(budgetDraft);
                                    if (!Number.isInteger(value) || value < 1 || value > 100) {
                                        setError("每日上限必须是 1-100 的整数");
                                        return;
                                    }
                                    void save({ maxActionsPerDay: value });
                                }}
                            >
                                保存
                            </Button>
                            <Box sx={{ flex: 1 }} />
                            <Button
                                size="small"
                                variant="contained"
                                disabled={busy !== null || mode === "off"}
                                startIcon={
                                    busy === "tick" ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                        <RefreshCw size={14} />
                                    )
                                }
                                onClick={() => void tick()}
                            >
                                立即检查
                            </Button>
                            {stopped ? (
                                <Button
                                    size="small"
                                    variant="outlined"
                                    disabled={busy !== null}
                                    startIcon={<PlayCircle size={14} />}
                                    onClick={() => void resume()}
                                >
                                    恢复
                                </Button>
                            ) : (
                                <Button
                                    size="small"
                                    variant="outlined"
                                    color="error"
                                    disabled={busy !== null}
                                    startIcon={<PauseCircle size={14} />}
                                    onClick={() => void stop()}
                                >
                                    急停
                                </Button>
                            )}
                        </Stack>
                    </Stack>

                    {setting?.lastResult && (
                        <Alert severity="info" icon={false} sx={{ py: 0.25 }}>
                            <Typography variant="caption" color="text.secondary">
                                上次结果：{setting.lastResult}
                            </Typography>
                        </Alert>
                    )}
                </Stack>
            </CardContent>
        </Card>
    );
}
