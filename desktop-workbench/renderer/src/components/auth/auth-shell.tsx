"use client"

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="aa-auth-shell h-dvh overflow-y-auto bg-background text-foreground">
      <header aria-hidden="true" className="aa-window-drag fixed inset-x-0 top-0 h-12" />
      <main className="flex min-h-full items-center justify-center px-6 py-20">
        <div className="aa-window-no-drag w-full max-w-[35rem]">
          {children}
        </div>
      </main>
    </div>
  )
}
