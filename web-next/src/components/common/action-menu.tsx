"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ActionMenuItem =
  | {
      type?: "item";
      id: string;
      label: React.ReactNode;
      icon?: React.ReactNode;
      shortcut?: React.ReactNode;
      disabled?: boolean;
      destructive?: boolean;
      onSelect?: () => void;
    }
  | {
      type: "separator";
      id: string;
    };

export interface ActionMenuProps {
  items: ActionMenuItem[];
  children?: React.ReactNode;
  label?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
  contentClassName?: string;
  onOpenChange?: (open: boolean) => void;
}

export function ActionMenu({
  items,
  children,
  label = "More actions",
  align = "end",
  side = "bottom",
  className,
  contentClassName,
  onOpenChange
}: ActionMenuProps) {
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        {children ?? (
          <Button
            type="button"
            variant="rowAction"
            size="rowAction"
            aria-label={label}
            title={label}
            className={className}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={12}
          className={cn(
            "z-50 min-w-40 overflow-hidden rounded-[var(--r)] border border-[var(--border-md)] bg-[var(--bg-panel)] p-1 text-[var(--fs-sm)] text-[var(--text-mid)] shadow-[var(--shadow-pop)] outline-none data-[state=open]:animate-[klaw-fade-up_0.12s_ease_both]",
            contentClassName,
          )}
        >
          {items.map((item) =>
            item.type === "separator" ? (
              <DropdownMenu.Separator
                key={item.id}
                className="-mx-1 my-1 h-px bg-[var(--border)]"
              />
            ) : (
              <DropdownMenu.Item
                key={item.id}
                disabled={item.disabled}
                onSelect={() => item.onSelect?.()}
                className={cn(
                  "flex h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2 outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--bg-hover)] data-[highlighted]:text-[var(--text)]",
                  item.destructive &&
                    "text-[oklch(0.72_0.16_25)] data-[highlighted]:text-[oklch(0.76_0.16_25)]",
                )}
              >
                {item.icon ? (
                  <span className="flex size-4 shrink-0 items-center justify-center text-current [&_svg]:size-3.5">
                    {item.icon}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {item.label}
                </span>
                {item.shortcut ? (
                  <span className="ml-4 font-mono text-[var(--fs-2xs)] text-[var(--text-faint)]">
                    {item.shortcut}
                  </span>
                ) : null}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
