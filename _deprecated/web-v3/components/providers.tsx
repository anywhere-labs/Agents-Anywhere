"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { useState, type ReactNode } from "react"

import { HtmlLang } from "@/components/i18n-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AssistantProvider } from "@/lib/state/assistant-context"
import { WorkbenchProvider } from "@/lib/state/workbench-context"

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            staleTime: 15_000,
          },
        },
      })
  )

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WorkbenchProvider>
            <AssistantProvider>
              <HtmlLang />
              {children}
              <Toaster position="bottom-right" />
            </AssistantProvider>
          </WorkbenchProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
