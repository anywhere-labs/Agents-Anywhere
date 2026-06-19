import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--r)] text-[var(--fs-ui)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
  {
    variants: {
      variant: {
        normal:
          "border border-[var(--border-md)] bg-[var(--bg-panel)] text-[var(--text-mid)] hover:border-[var(--border-lg)] hover:text-[var(--text)]",
        emphasis:
          "border border-transparent bg-[var(--emphasis-bg)] text-[var(--emphasis-ink)] font-semibold hover:opacity-90",
        default:
          "border border-[var(--border-md)] bg-[var(--bg-panel)] text-[var(--text-mid)] hover:border-[var(--border-lg)] hover:text-[var(--text)]",
        primary:
          "border border-transparent bg-[var(--emphasis-bg)] text-[var(--emphasis-ink)] font-semibold hover:opacity-90",
        ghost:
          "border border-transparent bg-transparent text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
        destructive:
          "border border-transparent bg-[oklch(0.72_0.16_25)] text-white hover:brightness-105",
        danger:
          "border border-transparent bg-[oklch(0.72_0.16_25)] text-white hover:brightness-105",
        rowAction:
          "border border-transparent bg-transparent text-[var(--text-mut)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] data-[state=open]:bg-[var(--bg-active)] data-[state=open]:text-[var(--text)]"
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-2.5 text-[var(--fs-sm)]",
        lg: "h-10 px-4",
        icon: "size-8 p-0",
        iconSm: "size-[30px] p-0 rounded-[7px]",
        rowAction: "size-7 p-0 rounded-md"
      }
    },
    defaultVariants: {
      variant: "normal",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
