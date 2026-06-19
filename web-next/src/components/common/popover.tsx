"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PopoverPanelProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}

export function PopoverPanel({
  trigger,
  children,
  open,
  onOpenChange,
  align = "start",
  side = "bottom",
  className
}: PopoverPanelProps) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={12}
          className={cn(
            "z-50 max-h-[min(420px,calc(100vh-32px))] w-[min(320px,calc(100vw-32px))] overflow-auto rounded-[var(--r)] border border-[var(--border-md)] bg-[var(--bg-panel)] p-2 text-[var(--fs-sm)] text-[var(--text-mid)] shadow-[var(--shadow-pop)] outline-none data-[state=open]:animate-[klaw-fade-up_0.12s_ease_both]",
            className,
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export interface PopoverSelectOption {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}

export interface PopoverSelectProps {
  value: string;
  options: PopoverSelectOption[];
  onValueChange: (value: string) => void;
  emptyLabel?: React.ReactNode;
}

export function PopoverSelect({
  value,
  options,
  onValueChange,
  emptyLabel = "No options"
}: PopoverSelectProps) {
  if (options.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-[var(--fs-xs)] text-[var(--text-mut)]">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={cn(
              "flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--fs-sm)] text-[var(--text-mid)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:pointer-events-none disabled:opacity-45",
              selected && "bg-[var(--bg-active)] text-[var(--text)]",
            )}
            disabled={option.disabled}
            onClick={() => onValueChange(option.value)}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {selected ? <Check className="size-3.5" aria-hidden="true" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
                {option.label}
              </span>
              {option.description ? (
                <span className="mt-0.5 block text-[var(--fs-xs)] leading-4 text-[var(--text-mut)]">
                  {option.description}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
