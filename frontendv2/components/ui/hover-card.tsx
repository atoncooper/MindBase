"use client";

/**
 * HoverCard — shadcn/ui-style wrapper over @radix-ui/react-hover-card.
 * Used for file-artifact previews (image thumbnails / metadata) without
 * navigating away from the chat.
 */
import * as Primitive from "@radix-ui/react-hover-card";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const HoverCard = Primitive.Root;
const HoverCardTrigger = Primitive.Trigger;

function HoverCardContent({
  className,
  sideOffset = 8,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-64 overflow-hidden rounded-xl border border-border-subtle bg-surface p-3 shadow-[0_8px_30px_rgba(0,0,0,0.12)]",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
