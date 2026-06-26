"use client"

import { useState } from "react"
import { Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { AuthShell } from "./auth-shell"
import { useAuth } from "./auth-context"
import { useTranslations } from "next-intl"

export function OAuthNewUserScreen() {
  const { navigate } = useAuth()
  const t = useTranslations("auth")
  const [setPassword, setSetPassword] = useState(false)
  const [oauthUsername, setOauthUsername] = useState("")
  const [password, setPassword2] = useState("")

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-3 text-center mb-8">
        <Avatar className="size-16 rounded-full">
          <AvatarImage src="/abstract-pixelated-avatar.png" alt="oauth avatar" />
          <AvatarFallback className="rounded-full bg-primary text-primary-foreground text-lg">T4</AvatarFallback>
        </Avatar>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">{t("oauth.createTitle")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("oauth.createDescription")}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="oauth-userid">{t("fields.userId")}</Label>
          <Input
            id="oauth-userid"
            value={oauthUsername}
            onChange={(e) => setOauthUsername(e.target.value)}
            className="code-mono h-11"
          />
        </div>

        <div className="flex items-center gap-2.5">
          <Checkbox
            id="set-password"
            checked={setPassword}
            onCheckedChange={(v) => setSetPassword(!!v)}
          />
          <Label htmlFor="set-password" className="text-sm font-normal cursor-pointer">
            {t("oauth.setLocalPassword")}
          </Label>
        </div>

        {setPassword && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="oauth-password">{t("fields.password")}</Label>
            <InputGroup className="h-11 rounded-lg">
              <InputGroupAddon><Lock className="size-4" /></InputGroupAddon>
              <InputGroupInput
                id="oauth-password"
                type="password"
                placeholder={t("register.passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword2(e.target.value)}
                className="code-mono"
              />
            </InputGroup>
          </div>
        )}

        <Button className="h-11 w-full font-medium" onClick={() => navigate("app")}>
          {t("oauth.createSubmit")}
        </Button>

        <Button variant="outline" className="h-11 w-full" onClick={() => navigate("login")}>
          {t("oauth.back")}
        </Button>
      </div>
    </AuthShell>
  )
}
