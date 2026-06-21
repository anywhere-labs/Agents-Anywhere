"use client"

import { useState } from "react"
import { User, Lock, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"

export function RegisterScreen() {
  const { navigate } = useAuth()
  const [showPassword, setShowPassword] = useState(false)

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-2 text-center mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Create an account</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {"You're joining a self-hosted"}<br />
          <span className="font-serif italic">Agents Anywhere</span>
          {" instance."}
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reg-userid">User ID</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><User className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="reg-userid"
              placeholder="enter your username"
              autoComplete="username"
              className="font-mono"
            />
          </InputGroup>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reg-password">Password</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="reg-password"
              type={showPassword ? "text" : "password"}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              className="font-mono"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reg-confirm">Confirm password</Label>
          <InputGroup className="h-11 rounded-lg">
            <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
            <InputGroupInput
              id="reg-confirm"
              type="password"
              placeholder="Repeat password"
              autoComplete="new-password"
              className="font-mono"
            />
          </InputGroup>
        </div>

        <Button
          variant="outline"
          className="h-11 w-full font-medium"
          onClick={() => navigate("app")}
        >
          Create account ↵
        </Button>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <button
            type="button"
            className="font-semibold text-foreground underline-offset-4 hover:underline"
            onClick={() => navigate("login")}
          >
            Sign in
          </button>
        </p>
      </div>
    </AuthShell>
  )
}
