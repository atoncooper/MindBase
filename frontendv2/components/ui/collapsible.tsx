"use client";

/**
 * Collapsible — shadcn/ui-style wrapper over @radix-ui/react-collapsible.
 *
 * Used by the AI thinking panel (reasoning + tool-call disclosure) and by the
 * file-artifact cards. Styling stays with the caller; this module only re-exports
 * the accessible Radix primitives (keyboard + aria handled by Radix).
 */
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";

const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger;
const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
