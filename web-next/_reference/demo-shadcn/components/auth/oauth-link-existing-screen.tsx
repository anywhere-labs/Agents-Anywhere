"use client"

import { useState } from "react"
import { Lock, Eye, EyeOff, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"

type Step = "confirm" | "verify" | "success"

export function OAuthLinkExistingScreen() {
  const { navigate, oauthProvider } = useAuth()
  const [step, setStep] = useState<Step>("confirm")
  const [showPassword, setShowPassword] = useState(false)
  const [password, setPassword] = useState("")

  if (step === "success") {
    return (
      <AuthShell>
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-emerald-500/15">
            <CheckCircle2 className="size-8 text-emerald-500" />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold tracking-tight">Account linked</h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Your {oauthProvider} identity has been linked to your account.
              <br />
              You can now sign in without a password using {oauthProvider}.
            </p>
          </div>
          <Button className="mt-4 h-11 w-full font-medium" onClick={() => navigate("app")}>
            Continue
          </Button>
        </div>
      </AuthShell>
    )
  }

  if (step === "verify") {
    return (
      <AuthShell>
        <div className="flex flex-col items-center gap-3 text-center mb-8">
          <Avatar className="size-16 rounded-md">
            <AvatarImage src="/abstract-pixelated-avatar.png" alt="t4wefan" />
            <AvatarFallback className="rounded-md bg-primary text-primary-foreground">T4</AvatarFallback>
          </Avatar>
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight">Verify your identity</h1>
            <p className="text-sm text-muted-foreground">
              Enter your password to link this {oauthProvider} account.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-password">Password</Label>
            <InputGroup className="h-11 rounded-lg">
              <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
              <InputGroupInput
                id="link-password"
                type={showPassword ? "text" : "password"}
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="font-mono"
                autoComplete="current-password"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </div>

          <Button
            className="h-11 w-full font-medium"
            disabled={!password}
            onClick={() => setStep("success")}
          >
            Verify and link
          </Button>

          <Button variant="outline" className="h-11 w-full" onClick={() => navigate("login")}>
            Back to sign in
          </Button>
        </div>
      </AuthShell>
    )
  }

  // step === "confirm"
  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-3 text-center mb-8">
        <Avatar className="size-16 rounded-md">
          <AvatarImage src="/abstract-pixelated-avatar.png" alt="t4wefan" />
          <AvatarFallback className="rounded-md bg-primary text-primary-foreground">T4</AvatarFallback>
        </Avatar>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">Is this your account?</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            A {oauthProvider} identity matched an existing account.
            <br />
            Link it to sign in without a password.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 mb-6">
        <div className="flex items-center gap-3">
          <Avatar className="size-10 rounded-md">
            <AvatarImage src="/abstract-pixelated-avatar.png" alt="t4wefan" />
            <AvatarFallback className="rounded-md bg-primary text-primary-foreground text-xs">T4</AvatarFallback>
          </Avatar>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-medium">t4wefan</span>
            <span className="text-xs text-muted-foreground">Admin</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Button className="h-11 w-full font-medium" onClick={() => setStep("verify")}>
          Yes, this is me — link account
        </Button>

        <Separator className="my-1" />

        <Button variant="outline" className="h-11 w-full" onClick={() => navigate("oauth-new-user")}>
          {"No, create a new account"}
        </Button>

        <Button variant="ghost" className="h-11 w-full text-muted-foreground" onClick={() => navigate("login")}>
          Back to sign in
        </Button>
      </div>
    </AuthShell>
  )
}
