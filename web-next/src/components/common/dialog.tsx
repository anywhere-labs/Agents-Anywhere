"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/common/icon-button";
import { cn } from "@/lib/utils";

export interface AppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  closeLabel?: string;
  modal?: boolean;
}

export function AppDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  contentClassName,
  closeLabel = "Close",
  modal = true
}: AppDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[min(760px,calc(100vh-32px))] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--border-md)] bg-[var(--bg-panel)] text-[var(--text)] shadow-[var(--shadow-pop)] outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            className,
          )}
        >
          <div className="flex min-h-12 shrink-0 items-start gap-3 border-b border-[var(--border)] px-4 py-3">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="m-0 text-[var(--fs-md)] font-semibold leading-6 text-[var(--text)]">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="m-0 mt-1 text-[var(--fs-sm)] leading-5 text-[var(--text-mut)]">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton label={closeLabel} size="sm">
                <X aria-hidden="true" />
              </IconButton>
            </DialogPrimitive.Close>
          </div>
          <div
            className={cn(
              "min-h-0 flex-1 overflow-auto px-4 py-4 text-[var(--fs-ui)] text-[var(--text-mid)]",
              contentClassName,
            )}
          >
            {children}
          </div>
          {footer ? (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
              {footer}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface DialogActionsProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function DialogActions({ className, ...props }: DialogActionsProps) {
  return (
    <div
      className={cn("flex items-center justify-end gap-2", className)}
      {...props}
    />
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel?: React.ReactNode;
  cancelLabel?: React.ReactNode;
  closeLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  closeLabel,
  destructive = false,
  loading = false,
  disabled = false,
  onConfirm
}: ConfirmDialogProps) {
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      closeLabel={closeLabel}
      className="w-[min(420px,calc(100vw-32px))]"
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "danger" : "emphasis"}
            disabled={disabled || loading}
            onClick={() => void onConfirm()}
          >
            {loading ? <span className="size-3 animate-[klaw-spin_0.7s_linear_infinite] rounded-full border border-current border-t-transparent" /> : null}
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </AppDialog>
  );
}
