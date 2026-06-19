"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/common/icon-button";
import { cn } from "@/lib/utils";

export type AppDialogSize = "sm" | "md" | "lg" | "xl";

export interface AppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  closeLabel?: string;
  modal?: boolean;
  hideClose?: boolean;
  role?: "dialog" | "alertdialog";
  size?: AppDialogSize;
}

const dialogSizeClass: Record<AppDialogSize, string> = {
  sm: "w-[min(380px,calc(100vw-32px))]",
  md: "w-[min(440px,calc(100vw-32px))]",
  lg: "w-[min(620px,calc(100vw-28px))]",
  xl: "w-[min(860px,calc(100vw-28px))]"
};

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
  modal = true,
  hideClose = false,
  role = "dialog",
  size = "md"
}: AppDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          role={role}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[min(760px,calc(100vh-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--border-md)] bg-[var(--bg-panel)] text-[var(--text)] shadow-[var(--shadow-pop)] outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            dialogSizeClass[size],
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
            {!hideClose ? (
              <DialogPrimitive.Close asChild>
                <IconButton label={closeLabel} size="sm">
                  <X aria-hidden="true" />
                </IconButton>
              </DialogPrimitive.Close>
            ) : null}
          </div>
          {children ? (
            <div
              className={cn(
                "min-h-0 flex-1 overflow-auto px-4 py-4 text-[var(--fs-ui)] text-[var(--text-mid)]",
                contentClassName,
              )}
            >
              {children}
            </div>
          ) : null}
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
  size?: AppDialogSize;
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
  size = "md",
  onConfirm
}: ConfirmDialogProps) {
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      closeLabel={closeLabel}
      role="alertdialog"
      size={size}
      hideClose
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
            {loading ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </AppDialog>
  );
}

export interface ExitConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  continueLabel?: React.ReactNode;
  exitLabel?: React.ReactNode;
  loading?: boolean;
  onExit: () => void | Promise<void>;
}

export function ExitConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  continueLabel = "Continue",
  exitLabel = "Exit",
  loading = false,
  onExit
}: ExitConfirmDialogProps) {
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      role="alertdialog"
      size="sm"
      hideClose
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {continueLabel}
          </Button>
          <Button
            type="button"
            variant="emphasis"
            onClick={() => void onExit()}
            disabled={loading}
          >
            {loading ? <Spinner /> : null}
            {exitLabel}
          </Button>
        </>
      }
    />
  );
}

export interface ExitGuardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  cancelLabel?: React.ReactNode;
  discardLabel?: React.ReactNode;
  saveLabel?: React.ReactNode;
  loading?: boolean;
  onDiscard: () => void | Promise<void>;
  onSave: () => void | Promise<void>;
}

export function ExitGuardDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel = "Cancel",
  discardLabel = "Discard",
  saveLabel = "Save",
  loading = false,
  onDiscard,
  onSave
}: ExitGuardDialogProps) {
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      role="alertdialog"
      size="sm"
      hideClose
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
            variant="ghost"
            className="border-[oklch(0.7_0.16_25_/_0.5)] text-[oklch(0.7_0.16_25)] hover:border-[oklch(0.7_0.16_25_/_0.7)] hover:bg-[oklch(0.7_0.16_25_/_0.10)] hover:text-[oklch(0.78_0.18_25)]"
            onClick={() => void onDiscard()}
            disabled={loading}
          >
            {discardLabel}
          </Button>
          <Button
            type="button"
            variant="emphasis"
            onClick={() => void onSave()}
            disabled={loading}
            autoFocus
          >
            {loading ? <Spinner /> : null}
            {saveLabel}
          </Button>
        </>
      }
    />
  );
}

function Spinner() {
  return (
    <span className="size-3 animate-[klaw-spin_0.7s_linear_infinite] rounded-full border border-current border-t-transparent" />
  );
}
