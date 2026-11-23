"use client"

import { ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * Pick one value from a dropdown menu: a pill button showing the current
 * choice, and a menu of options with the chosen one checked. Used in place of
 * native Select throughout the console.
 */
export function DropdownSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  children,
  align = "start",
  variant = "outline",
  size = "sm",
  className,
  contentClassName,
  itemClassName,
}: {
  value: T
  options: readonly { value: T; label: React.ReactNode }[]
  onChange: (value: T) => void
  /** Accessible name of the trigger. */
  label: string
  /** Trigger content; defaults to the chosen option's label. */
  children?: React.ReactNode
  align?: "start" | "center" | "end"
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
  className?: string
  contentClassName?: string
  itemClassName?: string
}) {
  const current = options.find((option) => option.value === value)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant={variant} size={size} className={className} />}
        aria-label={label}
      >
        {children ?? current?.label ?? value}
        <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className={contentClassName}>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as T)}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              closeOnClick
              className={itemClassName}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
