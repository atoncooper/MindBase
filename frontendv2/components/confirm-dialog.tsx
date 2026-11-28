"use client";

import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 共享确认弹窗 —— 直接使用 MUI 现成组件，不做自定义视觉。
 *
 * 结构 = MUI 官方 AlertDialog 写法：
 *   Dialog + DialogTitle + DialogContent/DialogContentText + DialogActions + Button。
 * Portal、焦点圈定/归还、body 滚动锁定、Escape/遮罩关闭、aria 关联均交给 MUI；
 * 这里不写渐变、毛玻璃或自定义配色：危险操作使用 MUI 标准 `color="error"` 红色，
 * 普通操作用默认主色。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      role="alertdialog"
      maxWidth="xs"
      fullWidth
      onClose={(_event, reason) => {
        if (busy) return;
        if (reason === "backdropClick" || reason === "escapeKeyDown") onCancel();
      }}
    >
      <DialogTitle>{title}</DialogTitle>
      {message && (
        <DialogContent>
          <DialogContentText>{message}</DialogContentText>
        </DialogContent>
      )}
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          onClick={onConfirm}
          color={danger ? "error" : "primary"}
          disabled={busy}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
