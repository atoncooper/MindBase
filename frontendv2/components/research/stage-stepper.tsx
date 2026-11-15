"use client";

/**
 * 六阶段步骤条（MUI Stepper + Google 风格）：当前阶段高亮，阶段状态用
 * 语义色 + 图标区分（locked 灰 / active 蓝 / submitted 橙 / approved 绿 / frozen 深灰）。
 *
 * 纯展示组件；点击某阶段只用于切换「当前查看阶段」（可选回调），不会写后端。
 * 契约保持不变：stages / current / selected / onSelect；无 onSelect 时步骤不可点。
 */
import { Box, Step, StepButton, StepLabel, Stepper, alpha } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { Check, Circle, Clock, Lock, Snowflake } from "lucide-react";
import type { AcademicStage, AcademicStageState, AcademicStageStatus } from "@/lib/api";
import { STAGE_LABELS, STAGE_ORDER } from "./research-ui";

interface Tone {
    main: string;
    bg: string;
    fg: string;
}

/** 阶段状态 → MUI 语义色（active/submitted/approved 用实色圆点，locked/frozen 用浅灰）。 */
function statusTone(theme: Theme, status: AcademicStageStatus): Tone {
    switch (status) {
        case "active":
            return {
                main: theme.palette.primary.main,
                bg: theme.palette.primary.main,
                fg: theme.palette.primary.contrastText,
            };
        case "submitted":
            return {
                main: theme.palette.warning.main,
                bg: alpha(theme.palette.warning.main, 0.14),
                fg: theme.palette.warning.dark,
            };
        case "approved":
            return {
                main: theme.palette.success.main,
                bg: theme.palette.success.main,
                fg: theme.palette.success.contrastText,
            };
        case "frozen":
            return {
                main: theme.palette.grey[400],
                bg: theme.palette.grey[200],
                fg: theme.palette.text.secondary,
            };
        default:
            return {
                main: theme.palette.grey[400],
                bg: theme.palette.background.paper,
                fg: theme.palette.text.disabled,
            };
    }
}

function StepGlyph({ status }: { status: AcademicStageStatus }) {
    const size = 13;
    switch (status) {
        case "approved":
            return <Check size={size} aria-hidden="true" />;
        case "submitted":
            return <Clock size={size} aria-hidden="true" />;
        case "active":
            return <Circle size={size} fill="currentColor" aria-hidden="true" />;
        case "frozen":
            return <Snowflake size={size} aria-hidden="true" />;
        default:
            return <Lock size={size} aria-hidden="true" />;
    }
}

function StepDot({
    index,
    state,
    highlighted,
}: {
    index: number;
    state?: AcademicStageState;
    highlighted: boolean;
}) {
    const status = state?.status ?? "locked";
    return (
        <Box
            sx={(theme: Theme) => {
                const tone = statusTone(theme, status);
                return {
                    display: "grid",
                    placeItems: "center",
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    border: "2px solid",
                    borderColor: tone.main,
                    bgcolor: tone.bg,
                    color: tone.fg,
                    fontSize: 11,
                    fontWeight: 600,
                    transition: "box-shadow 120ms ease",
                    ...(highlighted && { boxShadow: `0 0 0 4px ${alpha(tone.main, 0.14)}` }),
                };
            }}
        >
            {status === "locked" ? index + 1 : <StepGlyph status={status} />}
        </Box>
    );
}

export function StageStepper({
    stages,
    current,
    selected,
    onSelect,
}: {
    stages: Record<AcademicStage, AcademicStageState>;
    current: AcademicStage;
    selected?: AcademicStage;
    onSelect?: (stage: AcademicStage) => void;
}) {
    const activeStep = Math.max(0, STAGE_ORDER.indexOf(selected ?? current));

    return (
        <Stepper
            nonLinear
            alternativeLabel
            activeStep={activeStep}
            sx={{
                overflowX: "auto",
                minWidth: 0,
                pb: 0.5,
                "& .MuiStepConnector-line": { borderColor: "divider", borderTopWidth: 1 },
            }}
        >
            {STAGE_ORDER.map((stage, index) => {
                const state = stages[stage];
                const isCurrent = stage === current;
                const isSelected = stage === selected;
                const highlighted = isSelected || (!selected && isCurrent);
                const icon = <StepDot index={index} state={state} highlighted={highlighted} />;
                const optional = isCurrent ? (
                    <Box component="span" sx={{ color: "primary.main", fontSize: 10, lineHeight: 1.4 }}>
                        当前
                    </Box>
                ) : undefined;
                const labelSx = {
                    "& .MuiStepLabel-label": {
                        mt: 0.75,
                        fontSize: 11,
                        lineHeight: 1.35,
                        whiteSpace: "nowrap",
                        fontWeight: isCurrent ? 600 : 500,
                        color: isCurrent ? "text.primary" : "text.secondary",
                    },
                    "& .MuiStepLabel-label.Mui-active": {
                        color: "text.primary",
                    },
                    "& .MuiStepLabel-label.Mui-completed": {
                        color: "text.primary",
                    },
                } as const;

                return (
                    <Step
                        key={stage}
                        completed={state?.status === "approved"}
                        sx={{ minWidth: 74, px: 0.5 }}
                    >
                        {onSelect ? (
                            <StepButton
                                onClick={() => onSelect(stage)}
                                title={state?.note || STAGE_LABELS[stage]}
                                icon={icon}
                                optional={optional}
                                sx={labelSx}
                            >
                                {STAGE_LABELS[stage]}
                            </StepButton>
                        ) : (
                            <StepLabel
                                icon={icon}
                                optional={optional}
                                title={state?.note || STAGE_LABELS[stage]}
                                sx={labelSx}
                            >
                                {STAGE_LABELS[stage]}
                            </StepLabel>
                        )}
                    </Step>
                );
            })}
        </Stepper>
    );
}
