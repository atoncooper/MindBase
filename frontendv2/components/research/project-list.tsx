"use client";

/**
 * 左侧项目列表（MUI Paper + List，Google Workspace 风格）：搜索（标题/领域/
 * 目标期刊，本地过滤已加载的数据）、阶段徽标、文献/稿件计数 chip，以及
 * 「新建项目」入口。选中项使用 MUI selected 态（蓝色 tonal 背景）高亮。
 */
import { useMemo, useState } from "react";
import {
    Avatar,
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    IconButton,
    InputAdornment,
    LinearProgress,
    List,
    ListItem,
    ListItemButton,
    Paper,
    Stack,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material";
import { FlaskConical, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { academicApi, type AcademicProjectSummary } from "@/lib/api";
import {
    EmptyState,
    ErrorBanner,
    PAPER_TYPE_LABELS,
    STAGE_LABELS,
    StatusBadge,
    formatDate,
} from "./research-ui";

const COUNT_CHIP_SX = {
    height: 18,
    fontSize: 10.5,
    fontWeight: 500,
    bgcolor: "grey.100",
    color: "text.secondary",
    "& .MuiChip-label": { px: 0.75, lineHeight: 1.4 },
} as const;

export function ProjectList({
    projects,
    loading,
    error,
    selectedId,
    onSelect,
    onRetry,
    onCreate,
    embedded = false,
}: {
    projects: AcademicProjectSummary[];
    loading: boolean;
    error: string | null;
    selectedId: string | null;
    onSelect: (projectId: string) => void;
    onRetry: () => void;
    onCreate: () => void;
    /** Full-height rail mode (research full-screen shell): no outer card chrome. */
    embedded?: boolean;
}) {
    const [keyword, setKeyword] = useState("");
    const [recycleOpen, setRecycleOpen] = useState(false);
    const [archived, setArchived] = useState<AcademicProjectSummary[]>([]);
    const [recycleBusy, setRecycleBusy] = useState(false);
    const [recycleError, setRecycleError] = useState<string | null>(null);
    const [purgeTarget, setPurgeTarget] = useState<AcademicProjectSummary | null>(null);

    const openRecycleBin = async () => {
        setRecycleOpen(true);
        setRecycleBusy(true);
        setRecycleError(null);
        try {
            const result = await academicApi.listProjects({ archived: "only" });
            setArchived(result.projects);
        } catch (e) {
            setRecycleError(e instanceof Error ? e.message : "加载回收站失败");
        } finally {
            setRecycleBusy(false);
        }
    };

    const reloadArchived = async () => {
        const result = await academicApi.listProjects({ archived: "only" });
        setArchived(result.projects);
        onRetry();
    };

    const restoreArchived = async (projectId: string) => {
        setRecycleBusy(true);
        setRecycleError(null);
        try {
            await academicApi.restoreProject(projectId);
            await reloadArchived();
        } catch (e) {
            setRecycleError(e instanceof Error ? e.message : "恢复项目失败");
        } finally {
            setRecycleBusy(false);
        }
    };

    const confirmPurge = async () => {
        const project = purgeTarget;
        if (!project) return;
        setPurgeTarget(null);
        setRecycleBusy(true);
        setRecycleError(null);
        try {
            await academicApi.purgeProject(project.id);
            await reloadArchived();
        } catch (e) {
            setRecycleError(e instanceof Error ? e.message : "永久删除失败");
        } finally {
            setRecycleBusy(false);
        }
    };

    const filtered = useMemo(() => {
        const q = keyword.trim().toLowerCase();
        if (!q) return projects;
        return projects.filter((project) => {
            const haystack = [project.title, project.field, project.targetJournal ?? ""]
                .join(" ")
                .toLowerCase();
            return haystack.includes(q);
        });
    }, [projects, keyword]);

    return (
        <Paper
            variant={embedded ? "elevation" : "outlined"}
            elevation={0}
            sx={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
                borderRadius: embedded ? 0 : "8px",
                border: embedded ? 0 : 1,
                overflow: "hidden",
            }}
        >
            <Stack
                direction="row"
                sx={{
                    alignItems: "center",
                    justifyContent: "space-between",
                    px: 2,
                    py: 1.5,
                    borderBottom: 1,
                    borderColor: "divider",
                }}
            >
                <Typography variant="h3" sx={{ fontSize: 14, fontWeight: 500 }}>
                    我的研究项目
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                    <Tooltip title="回收站">
                        <IconButton
                            size="small"
                            aria-label="回收站"
                            onClick={() => void openRecycleBin()}
                            sx={{ width: 30, height: 30, color: "text.secondary" }}
                        >
                            <Trash2 size={16} aria-hidden="true" />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title="新建项目">
                        <IconButton
                            size="small"
                            aria-label="新建项目"
                            onClick={onCreate}
                            sx={{
                                width: 30,
                                height: 30,
                                bgcolor: "primary.main",
                                color: "primary.contrastText",
                                "&:hover": { bgcolor: "primary.dark" },
                            }}
                        >
                            <Plus size={16} aria-hidden="true" />
                        </IconButton>
                    </Tooltip>
                </Stack>
            </Stack>

            <Dialog open={recycleOpen} onClose={() => setRecycleOpen(false)} fullWidth maxWidth="sm">
                <DialogTitle sx={{ fontSize: 16 }}>回收站</DialogTitle>
                <DialogContent dividers>
                    {recycleError && <ErrorBanner message={recycleError} onRetry={() => void openRecycleBin()} />}
                    {recycleBusy && (
                        <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
                            <CircularProgress size={20} />
                        </Box>
                    )}
                    {!recycleBusy && archived.length === 0 && (
                        <Typography variant="body2" color="text.secondary">
                            回收站为空。删除的项目会先移入这里，可恢复或永久删除。
                        </Typography>
                    )}
                    <List dense disablePadding>
                        {archived.map((project) => (
                            <ListItem
                                key={project.id}
                                divider
                                secondaryAction={
                                    <Stack direction="row" spacing={0.5}>
                                        <Button
                                            size="small"
                                            startIcon={<RotateCcw size={13} aria-hidden="true" />}
                                            onClick={() => void restoreArchived(project.id)}
                                            disabled={recycleBusy}
                                        >
                                            恢复
                                        </Button>
                                        <Button
                                            size="small"
                                            color="error"
                                            startIcon={<Trash2 size={13} aria-hidden="true" />}
                                            onClick={() => setPurgeTarget(project)}
                                            disabled={recycleBusy}
                                        >
                                            永久删除
                                        </Button>
                                    </Stack>
                                }
                            >
                                <Box sx={{ minWidth: 0 }}>
                                    <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>
                                        {project.title}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        {project.archivedAt
                                            ? `归档于 ${new Date(project.archivedAt).toLocaleString()}`
                                            : "已归档"}
                                    </Typography>
                                </Box>
                            </ListItem>
                        ))}
                    </List>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setRecycleOpen(false)}>关闭</Button>
                </DialogActions>
            </Dialog>

            <Dialog
                open={purgeTarget !== null}
                onClose={() => {
                    if (!recycleBusy) setPurgeTarget(null);
                }}
                maxWidth="xs"
                fullWidth
            >
                <DialogTitle>永久删除项目？</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        「{purgeTarget?.title}」将被永久删除，文献、稿件、事件、审批、实验记录等子数据会一并清理，且不可恢复。
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setPurgeTarget(null)} disabled={recycleBusy}>
                        取消
                    </Button>
                    <Button color="error" variant="contained" onClick={() => void confirmPurge()} disabled={recycleBusy}>
                        永久删除
                    </Button>
                </DialogActions>
            </Dialog>

            <Box sx={{ px: 1.5, pt: 1.5 }}>
                <TextField
                    size="small"
                    fullWidth
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    placeholder="搜索项目"
                    aria-label="搜索项目"
                    slotProps={{
                        input: {
                            startAdornment: (
                                <InputAdornment position="start">
                                    <Search size={15} aria-hidden="true" />
                                </InputAdornment>
                            ),
                            endAdornment: keyword ? (
                                <InputAdornment position="end">
                                    <IconButton
                                        size="small"
                                        edge="end"
                                        aria-label="清除搜索"
                                        onClick={() => setKeyword("")}
                                    >
                                        <X size={14} aria-hidden="true" />
                                    </IconButton>
                                </InputAdornment>
                            ) : undefined,
                            sx: {
                                borderRadius: "8px",
                                bgcolor: "grey.100",
                                "& fieldset": { borderColor: "transparent" },
                                "&:hover fieldset": { borderColor: "divider" },
                                "&.Mui-focused fieldset": { borderColor: "primary.main" },
                            },
                        },
                    }}
                />
            </Box>

            {error && (
                <Box sx={{ px: 1.5, pt: 1.5 }}>
                    <ErrorBanner message={error} onRetry={onRetry} />
                </Box>
            )}

            {loading && <LinearProgress sx={{ mx: 1.5, mt: 1.5, borderRadius: "2px" }} />}

            <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", py: 1 }}>
                {!loading && filtered.length === 0 ? (
                    <EmptyState
                        icon={FlaskConical}
                        title={projects.length === 0 ? "还没有研究项目" : "没有匹配的项目"}
                        description={
                            projects.length === 0
                                ? "新建项目后，文献、写作与实验记录会关联在这里。"
                                : "换个关键词再试试。"
                        }
                        action={
                            projects.length === 0 ? (
                                <Button
                                    size="small"
                                    variant="contained"
                                    startIcon={<Plus size={14} aria-hidden="true" />}
                                    onClick={onCreate}
                                >
                                    新建项目
                                </Button>
                            ) : undefined
                        }
                    />
                ) : (
                    <List dense disablePadding sx={{ px: 1 }}>
                        {filtered.map((project) => {
                            const active = project.id === selectedId;
                            const status = project.stages[project.stage]?.status ?? "locked";
                            const initial = project.title.trim().slice(0, 1) || "研";
                            return (
                                <ListItem key={project.id} disablePadding sx={{ mb: 0.5 }}>
                                    <ListItemButton
                                        selected={active}
                                        onClick={() => onSelect(project.id)}
                                        sx={{ alignItems: "flex-start", gap: 1.25, borderRadius: "8px", px: 1.25, py: 1 }}
                                    >
                                        <Avatar
                                            sx={{
                                                width: 30,
                                                height: 30,
                                                mt: 0.25,
                                                fontSize: 13,
                                                fontWeight: 600,
                                                bgcolor: active ? "primary.main" : "grey.100",
                                                color: active ? "primary.contrastText" : "text.secondary",
                                            }}
                                        >
                                            {initial}
                                        </Avatar>
                                        <Box sx={{ minWidth: 0, flex: 1 }}>
                                            <Stack
                                                direction="row"
                                                spacing={0.75}
                                                sx={{
                                                    alignItems: "flex-start",
                                                    justifyContent: "space-between",
                                                }}
                                            >
                                                <Typography
                                                    component="span"
                                                    sx={{
                                                        fontSize: 13,
                                                        fontWeight: active ? 600 : 500,
                                                        lineHeight: 1.4,
                                                        color: active ? "primary.dark" : "text.primary",
                                                        wordBreak: "break-word",
                                                    }}
                                                >
                                                    {project.title}
                                                </Typography>
                                                <Box sx={{ flexShrink: 0 }}>
                                                    <StatusBadge status={status} />
                                                </Box>
                                            </Stack>
                                            <Typography
                                                component="div"
                                                variant="caption"
                                                sx={{ mt: 0.5, color: "text.secondary", lineHeight: 1.4 }}
                                            >
                                                {PAPER_TYPE_LABELS[project.paperType]} · 阶段：
                                                {STAGE_LABELS[project.stage]}
                                            </Typography>
                                            <Stack
                                                direction="row"
                                                spacing={0.5}
                                                useFlexGap
                                                sx={{ mt: 0.5, flexWrap: "wrap" }}
                                            >
                                                <Chip
                                                    size="small"
                                                    label={`文献 ${project.literatureCount}`}
                                                    sx={COUNT_CHIP_SX}
                                                />
                                                <Chip
                                                    size="small"
                                                    label={`稿件 ${project.documentCount}`}
                                                    sx={COUNT_CHIP_SX}
                                                />
                                            </Stack>
                                            <Typography
                                                component="div"
                                                variant="caption"
                                                sx={{ mt: 0.5, color: "text.secondary", lineHeight: 1.4 }}
                                            >
                                                截止{" "}
                                                {formatDate(
                                                    project.deadline
                                                        ? new Date(project.deadline).getTime()
                                                        : undefined,
                                                )}
                                                {" · "}
                                                更新 {formatDate(project.updatedAt)}
                                            </Typography>
                                        </Box>
                                    </ListItemButton>
                                </ListItem>
                            );
                        })}
                    </List>
                )}
            </Box>
        </Paper>
    );
}
