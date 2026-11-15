"use client";

/**
 * 云盘「科研项目文件」只读弹层（MUI Google / Material 3 外观）。
 *
 * 云盘侧栏不展示科研工作台自动维护的「学术研究/<项目>/00_课题与计划…06_投稿」
 * 目录（避免误改结构）；这里提供只读入口：选择科研项目后复用 ProjectFilesPanel
 * （readOnly）查看 AI 生成/回存的项目文件，预览/下载/刷新保留，写操作仍在科研工作台。
 * 组件禁止直接 fetch：项目列表走 academicApi，文件/预览/下载由面板内 cloudApi 负责。
 * 关闭即卸载（项目列表/选择/面板状态全部丢弃，下次打开重新拉取）。
 */
import { useCallback, useEffect, useState } from "react";
import { FlaskConical, X } from "lucide-react";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { GoogleResearchTheme } from "@/components/research/google-theme";
import { ProjectFilesPanel } from "@/components/research/project-files-panel";
import { academicApi, type AcademicProjectSummary } from "@/lib/api";

export function ResearchFilesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    // 弹层关闭即卸载内容组件（状态清零；下次打开重新拉项目列表）。
    if (!open) return null;
    return (
        <GoogleResearchTheme>
            <ResearchFilesDialogContent onClose={onClose} />
        </GoogleResearchTheme>
    );
}

function ResearchFilesDialogContent({ onClose }: { onClose: () => void }) {
    const [projects, setProjects] = useState<AcademicProjectSummary[]>([]);
    const [projectId, setProjectId] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await academicApi.listProjects();
            const list = result.projects;
            setProjects(list);
            // 默认选第一个；重新拉取后保留当前仍存在的选择。
            setProjectId((current) =>
                list.some((project) => project.id === current) ? current : (list[0]?.id ?? ""),
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载科研项目失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // 首屏拉取。load() 会同步 setLoading(true)，放到定时器里执行以避开
        // react-hooks/set-state-in-effect 的同步级联渲染（同其它弹层写法）。
        const timer = window.setTimeout(() => void load(), 0);
        return () => window.clearTimeout(timer);
    }, [load]);

    return (
        <Dialog
            open
            onClose={onClose}
            maxWidth="md"
            fullWidth
            slotProps={{ paper: { sx: { borderRadius: "8px", maxHeight: "88vh" } } }}
        >
            <DialogTitle
                sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1.5,
                    pr: 2,
                    borderBottom: 1,
                    borderColor: "divider",
                }}
            >
                <Avatar
                    variant="rounded"
                    sx={{
                        width: 36,
                        height: 36,
                        borderRadius: "8px",
                        bgcolor: "primary.main",
                        color: "primary.contrastText",
                    }}
                >
                    <FlaskConical size={18} strokeWidth={2} />
                </Avatar>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="h3" component="h2" noWrap>
                        科研项目文件
                    </Typography>
                    <Typography variant="caption" noWrap sx={{ display: "block", color: "text.secondary" }}>
                        只读 · 科研工作台管理
                    </Typography>
                </Box>
                <IconButton size="small" aria-label="关闭" onClick={onClose} sx={{ color: "text.secondary" }}>
                    <X size={18} />
                </IconButton>
            </DialogTitle>

            <DialogContent sx={{ py: 2.5, bgcolor: "#f8f9fa" }}>
                <Stack spacing={2.5}>
                    <Alert
                        severity="info"
                        icon={<FlaskConical size={20} />}
                        sx={{
                            borderRadius: "8px",
                            bgcolor: "#e8f0fe",
                            color: "#174ea6",
                            "& .MuiAlert-icon": { color: "#1a73e8" },
                        }}
                    >
                        <Typography variant="body2">
                            只读：这些文件由科研工作台管理（00_课题与计划 … 06_投稿 / 写作来源与回存），
                            云盘不展示原始目录，避免误改结构。
                        </Typography>
                    </Alert>

                    {loading ? (
                        <Box>
                            <LinearProgress sx={{ borderRadius: "2px" }} />
                            <Stack spacing={1} sx={{ mt: 2 }}>
                                {[0, 1, 2].map((row) => (
                                    <Skeleton
                                        key={row}
                                        variant="rounded"
                                        height={48}
                                        sx={{ borderRadius: "8px" }}
                                    />
                                ))}
                            </Stack>
                        </Box>
                    ) : error ? (
                        <Alert
                            severity="error"
                            sx={{ borderRadius: "8px" }}
                            action={
                                <Button color="inherit" size="small" onClick={() => void load()}>
                                    重试
                                </Button>
                            }
                        >
                            {error}
                        </Alert>
                    ) : projects.length === 0 ? (
                        <Box
                            sx={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                justifyContent: "center",
                                textAlign: "center",
                                px: 3,
                                py: 6,
                            }}
                        >
                            <Avatar sx={{ width: 56, height: 56, bgcolor: "#f1f3f4", color: "#5f6368" }}>
                                <FlaskConical size={26} />
                            </Avatar>
                            <Typography variant="h3" component="p" sx={{ mt: 2 }}>
                                还没有科研项目
                            </Typography>
                            <Typography
                                variant="body2"
                                sx={{ mt: 0.5, maxWidth: 380, color: "text.secondary" }}
                            >
                                在「科研」工作台创建项目后，AI 生成/回存的项目文件会在这里只读展示。
                            </Typography>
                        </Box>
                    ) : (
                        <>
                            <FormControl fullWidth size="small" sx={{ maxWidth: 480, bgcolor: "#ffffff" }}>
                                <InputLabel id="research-files-project-label">科研项目</InputLabel>
                                <Select
                                    labelId="research-files-project-label"
                                    label="科研项目"
                                    value={projectId}
                                    onChange={(event) => setProjectId(String(event.target.value))}
                                >
                                    {projects.map((project) => (
                                        <MenuItem key={project.id} value={project.id}>
                                            {project.title}
                                        </MenuItem>
                                    ))}
                                </Select>
                            </FormControl>

                            {projectId && (
                                <ProjectFilesPanel projectId={projectId} title="项目文件" readOnly />
                            )}
                        </>
                    )}
                </Stack>
            </DialogContent>
        </Dialog>
    );
}
