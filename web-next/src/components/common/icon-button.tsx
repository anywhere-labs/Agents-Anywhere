import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface IconButtonProps extends Omit<ButtonProps, "size"> {
  label: string;
  size?: "sm" | "md" | "row";
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, className, children, size = "md", variant = "ghost", ...props }, ref) => {
    const buttonSize =
      size === "sm" ? "iconSm" : size === "row" ? "rowAction" : "icon";

    return (
      <Button
        ref={ref}
        type="button"
        variant={variant}
        size={buttonSize}
        className={cn("shrink-0", className)}
        aria-label={label}
        title={props.title ?? label}
        {...props}
      >
        {children}
      </Button>
    );
  },
);
IconButton.displayName = "IconButton";
