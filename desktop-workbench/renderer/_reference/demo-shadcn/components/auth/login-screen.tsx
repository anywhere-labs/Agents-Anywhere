"use client"

import { useState } from "react"
import { Globe, User, Lock, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"

export function LoginScreen() {
  const { navigate } = useAuth()
  const [showPassword, setShowPassword] = useState(false)

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-2 text-center mb-8">
        <h1 className="text-2xl font-bold tracking-tight">
          Sign in to{" "}
          <span className="font-serif italic font-normal">Agents Anywhere</span>
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Use the credentials your instance admin<br />gave you.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="login-userid">User ID</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><User className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="login-userid"
              placeholder="enter your username"
              autoComplete="username"
              className="font-mono"
            />
          </InputGroup>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="login-password">Password</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="login-password"
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              autoComplete="current-password"
              className="font-mono"
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
          onClick={() => navigate("app")}
        >
          Sign in ↵
        </Button>

        <Button
          variant="outline"
          className="h-11 w-full gap-2"
          onClick={() => navigate("oauth-link-existing")}
        >
          <Globe className="size-4" />
          Sign in with GitLab
        </Button>

        <div className="flex flex-col items-center gap-1 text-sm text-muted-foreground">
          <p>
            New here?{" "}
            <button
              type="button"
              className="font-medium text-foreground underline-offset-4 hover:underline"
              onClick={() => navigate("register")}
            >
              Create an account
            </button>
          </p>
          <p>Forgot your password? Ask your instance admin to reset it.</p>
        </div>
      </div>
    </AuthShell>
  )
}
