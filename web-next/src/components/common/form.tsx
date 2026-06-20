"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { IconButton } from "@/components/common/icon-button";
import { cn } from "@/lib/utils";

export interface FormFieldProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  label?: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
}

export function FormField({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
  ...props
}: FormFieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)} {...props}>
      {label || hint ? (
        <div className="flex items-center justify-between gap-3">
          {label ? (
            <label
              htmlFor={htmlFor}
              className="text-[var(--fs-sm)] font-medium text-[var(--text-mid)]"
            >
              {label}
            </label>
          ) : (
            <span />
          )}
          {hint ? (
            <span className="font-mono text-[var(--fs-xs)] text-[var(--text-mut)]">
              {hint}
            </span>
          ) : null}
        </div>
      ) : null}
      {children}
      {error ? <FormError>{error}</FormError> : null}
    </div>
  );
}

const inputVariants = cva(
  "w-full border border-[var(--border-md)] bg-[var(--input-bg)] px-3 text-[length:var(--fs-base)] text-[color:var(--text)] outline-none transition-colors placeholder:font-mono placeholder:text-[length:var(--fs-ui)] placeholder:text-[color:var(--text-faint)] hover:border-[var(--border-lg)] focus:border-[var(--accent)] focus:bg-[var(--bg-panel)] autofill:shadow-[0_0_0_1000px_var(--input-bg)_inset] autofill:[-webkit-text-fill-color:var(--text)] focus:autofill:shadow-[0_0_0_1000px_var(--bg-panel)_inset] focus:autofill:[-webkit-text-fill-color:var(--text)] disabled:cursor-not-allowed disabled:opacity-55",
  {
    variants: {
      size: {
        default: "h-10 rounded-[var(--r)]",
        sm: "h-8 rounded-md text-[length:var(--fs-sm)]",
        compact: "h-7 rounded-md px-2 text-[length:var(--fs-sm)]"
      },
      mono: {
        true: "font-mono text-[length:var(--fs-ui)]",
        false: ""
      }
    },
    defaultVariants: {
      size: "default",
      mono: false
    }
  },
);

export interface TextInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(
  ({ className, size, mono, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(inputVariants({ size, mono, className }))}
      {...props}
    />
  ),
);
TextInput.displayName = "TextInput";

export interface TextAreaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ className, mono = false, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "min-h-24 w-full resize-y rounded-[var(--r)] border border-[var(--border-md)] bg-[var(--bg-input)] px-3 py-2 text-[var(--fs-base)] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-faint)] hover:border-[var(--border-lg)] focus:border-[var(--accent)] focus:bg-[var(--bg-panel)] disabled:cursor-not-allowed disabled:opacity-55",
        mono && "font-mono text-[var(--fs-ui)]",
        className,
      )}
      {...props}
    />
  ),
);
TextArea.displayName = "TextArea";

export interface PasswordFieldProps
  extends Omit<TextInputProps, "type" | "size"> {
  showLabel?: string;
  hideLabel?: string;
}

export const PasswordField = React.forwardRef<HTMLInputElement, PasswordFieldProps>(
  ({ className, showLabel = "Show password", hideLabel = "Hide password", ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);

    return (
      <div className="relative flex items-center">
        <TextInput
          ref={ref}
          type={visible ? "text" : "password"}
          className={cn("pr-10", className)}
          {...props}
        />
        <IconButton
          label={visible ? hideLabel : showLabel}
          size="sm"
          className="absolute right-1"
          onClick={() => setVisible((next) => !next)}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </IconButton>
      </div>
    );
  },
);
PasswordField.displayName = "PasswordField";

export interface FormErrorProps extends React.HTMLAttributes<HTMLDivElement> {}

export function FormError({ className, ...props }: FormErrorProps) {
  return (
    <div
      role="alert"
      className={cn("text-[var(--fs-xs)] leading-5 text-[oklch(0.76_0.16_25)]", className)}
      {...props}
    />
  );
}

export interface InlineAlertProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
}

const alertTone = {
  neutral: "border-[var(--border)] bg-[var(--bg-elev)] text-[var(--text-mid)]",
  info: "border-[color-mix(in_oklch,var(--info)_35%,transparent)] bg-[var(--info-soft)] text-[var(--text-mid)]",
  success:
    "border-[oklch(0.72_0.14_152_/_0.35)] bg-[oklch(0.72_0.14_152_/_0.12)] text-[var(--text-mid)]",
  warning:
    "border-[color-mix(in_oklch,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] text-[var(--text-mid)]",
  danger:
    "border-[oklch(0.72_0.16_25_/_0.35)] bg-[oklch(0.72_0.16_25_/_0.12)] text-[var(--text-mid)]"
} satisfies Record<NonNullable<InlineAlertProps["tone"]>, string>;

export function InlineAlert({
  tone = "neutral",
  className,
  ...props
}: InlineAlertProps) {
  return (
    <div
      className={cn(
        "rounded-[var(--r)] border px-3 py-2 text-[var(--fs-sm)] leading-5",
        alertTone[tone],
        className,
      )}
      {...props}
    />
  );
}
