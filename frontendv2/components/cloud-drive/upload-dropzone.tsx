"use client";

/**
 * Upload dropzone + progress pill.
 *
 * UploadDropzone wraps the main file area: it detects file drag-over and
 * shows a full-area accent-tinted overlay, then forwards dropped files to the
 * parent. A drag counter handles nested dragenter/leave so the overlay does
 * not flicker. UploadProgressPill is a fixed bottom-center pill with the
 * filename + percent, shown while a chunked upload is in flight.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CloudUpload, Loader2, Check } from "lucide-react";

export function UploadDropzone({
    onFiles,
    children,
}: {
    onFiles: (files: FileList) => void;
    children: ReactNode;
}) {
    const [dragging, setDragging] = useState(false);
    // Counter so nested enter/leave (child elements) don't toggle the overlay.
    const depthRef = useRef(0);

    const onDragEnter = useCallback((e: React.DragEvent) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        depthRef.current += 1;
        setDragging(true);
    }, []);

    const onDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (depthRef.current === 0) setDragging(false);
    }, []);

    const onDragOver = useCallback((e: React.DragEvent) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
    }, []);

    const onDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            depthRef.current = 0;
            setDragging(false);
            if (e.dataTransfer?.files?.length) {
                onFiles(e.dataTransfer.files);
            }
        },
        [onFiles]
    );

    return (
        <div
            className="relative flex h-full flex-col"
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDragOver={onDragOver}
            onDrop={onDrop}
        >
            {children}
            <AnimatePresence>
                {dragging && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="pointer-events-none absolute inset-0 z-30 m-3 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-accent/50 bg-accent-soft/40 backdrop-blur-[2px]"
                    >
                        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-surface text-accent shadow-[0_4px_16px_rgba(0,0,0,0.08)]">
                            <CloudUpload className="h-7 w-7" />
                        </span>
                        <p className="mt-3 text-[15px] font-medium text-foreground">
                            松开以上传到当前文件夹
                        </p>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

export function UploadProgressPill({
    name,
    pct,
    done,
}: {
    name: string;
    pct: number;
    done: boolean;
}) {
    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 16 }}
                transition={{ duration: 0.2 }}
                className="pointer-events-none fixed bottom-5 left-1/2 z-40 -translate-x-1/2"
            >
                <div className="flex w-[320px] items-center gap-3 rounded-2xl border border-border bg-surface/95 px-3.5 py-2.5 shadow-[0_8px_32px_rgba(0,0,0,0.12)] backdrop-blur-xl">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                        {done ? (
                            <Check className="h-4 w-4 text-success" />
                        ) : (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                    </span>
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-medium text-foreground">
                            {done ? "上传完成" : "正在上传"}
                        </p>
                        <p className="truncate text-[11px] text-secondary" title={name}>
                            {name}
                        </p>
                        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-border-subtle">
                            <div
                                className="h-full rounded-full bg-accent transition-[width] duration-200"
                                style={{ width: `${pct}%` }}
                            />
                        </div>
                    </div>
                    <span className="text-[12px] font-medium tabular-nums text-secondary">
                        {pct}%
                    </span>
                </div>
            </motion.div>
        </AnimatePresence>
    );
}
