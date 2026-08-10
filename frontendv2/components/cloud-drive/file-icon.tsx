"use client";

/**
 * File icon tile - maps a MIME type to a lucide glyph on a tinted square.
 *
 * Apple-restrained: monochrome icons on very soft tinted tiles, never the
 * loud Google-Drive-style saturated colors. Tile + icon scale with `size`.
 */
import {
    FileVideo,
    FileText,
    FileImage,
    FileArchive,
    File,
    FileType2,
    type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface IconMeta {
    Icon: LucideIcon;
    tile: string;
    iconClass: string;
}

function getIconMeta(mimeType: string): IconMeta {
    const m = mimeType.toLowerCase();
    if (m.startsWith("video/")) {
        return { Icon: FileVideo, tile: "bg-accent/10", iconClass: "text-accent" };
    }
    if (m.startsWith("image/")) {
        return { Icon: FileImage, tile: "bg-success/10", iconClass: "text-success" };
    }
    if (m === "application/pdf") {
        return { Icon: FileType2, tile: "bg-danger/10", iconClass: "text-danger" };
    }
    if (m.includes("markdown") || m === "text/plain" || m.startsWith("text/")) {
        return { Icon: FileText, tile: "bg-foreground/[0.06]", iconClass: "text-secondary" };
    }
    if (m.includes("officedocument") || m.includes("msword") || m.includes("word") || m.includes("presentation") || m.includes("sheet")) {
        return { Icon: FileText, tile: "bg-accent/10", iconClass: "text-accent" };
    }
    if (m.includes("zip") || m.includes("rar") || m.includes("7z") || m.includes("compressed") || m.includes("tar")) {
        return { Icon: FileArchive, tile: "bg-warning/10", iconClass: "text-warning" };
    }
    return { Icon: File, tile: "bg-border-subtle", iconClass: "text-secondary" };
}

const DIMS: Record<string, { tile: string; icon: string }> = {
    sm: { tile: "h-8 w-8 rounded-lg", icon: "h-4 w-4" },
    md: { tile: "h-10 w-10 rounded-xl", icon: "h-5 w-5" },
    lg: { tile: "h-14 w-14 rounded-2xl", icon: "h-7 w-7" },
};

export function FileIconTile({
    mimeType,
    size = "md",
}: {
    mimeType: string;
    size?: "sm" | "md" | "lg";
}) {
    const { Icon, tile, iconClass } = getIconMeta(mimeType);
    const dims = DIMS[size];
    return (
        <span className={cn("grid shrink-0 place-items-center", dims.tile, tile)}>
            <Icon className={cn(dims.icon, iconClass)} />
        </span>
    );
}
