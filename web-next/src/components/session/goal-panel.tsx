"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { Target, Pause, Play, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Field, FieldGroup } from "@/components/ui/field";
import type { useSessionGoal } from "@/features/goals/use-session-goal";
export type GoalController = ReturnType<typeof useSessionGoal>;
function duration(seconds: number) {
  const m = Math.floor(Math.max(0, seconds) / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}h ${m % 60}m`
    : m > 0
      ? `${m}m`
      : `${Math.floor(Math.max(0, seconds))}s`;
}
export function GoalPanel({ goals }: { goals: GoalController }) {
  const t = useTranslations("goal"),
    g = goals.state?.goal;
  const [editing, setEditing] = React.useState(false),
    [text, setText] = React.useState("");
  const [resuming, setResuming] = React.useState(false);
  const [clock, setClock] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  React.useEffect(() => {
    setEditing(false);
    setResuming(false);
  }, [goals.state?.sessionId, g?.id]);
  const actions =
    goals.state?.freshness === "fresh"
      ? (goals.state.capabilities?.actions ?? [])
      : [];
  const elapsed =
    g?.timeUsedSeconds == null
      ? null
      : g.timeUsedSeconds +
        (g?.status === "active"
          ? Math.max(0, (clock - Date.parse(g.updatedAt)) / 1000)
          : 0);
  const progress =
    g?.tokenBudget != null &&
    g.tokensUsed != null &&
    (g.status === "active" || g.status === "budgetLimited")
      ? `${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(g.tokensUsed ?? 0)} / ${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(g.tokenBudget)}`
      : elapsed == null
        ? null
        : duration(elapsed);
  const save = async () => {
    if (await goals.execute("edit", text.trim())) setEditing(false);
  };
  return (
    <div className="mx-auto w-full min-w-0 max-w-[calc(48rem+2rem)] px-4">
      {g && (
        <div
          className="flex min-w-0 items-center gap-2 py-2 text-sm"
          aria-label={t("title")}
        >
          <Target className="size-4 shrink-0" aria-hidden />
          <span className="shrink-0">{t("status", { status: g.status })}</span>
          <Button
            variant="ghost"
            className="min-w-0 flex-1 shrink justify-start"
            disabled={goals.busy || !actions.includes("edit")}
            onClick={() => {
              setText(g.objective);
              setEditing(true);
            }}
            title={g.objective}
          >
            <span className="truncate">{g.objective}</span>
          </Button>
          {progress && (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {progress}
            </span>
          )}
          {g.status === "active" && actions.includes("pause") && (
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={goals.busy}
              aria-label={t("pause")}
              onClick={() => void goals.execute("pause")}
            >
              <Pause />
            </Button>
          )}
          {["paused", "blocked", "usageLimited"].includes(g.status) &&
            actions.includes("resume") && (
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={goals.busy}
                aria-label={t("resume")}
                onClick={() => setResuming(true)}
              >
                <Play />
              </Button>
            )}
          {actions.includes("clear") && (
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={goals.busy}
              aria-label={t("clear")}
              onClick={() => void goals.execute("clear")}
            >
              <X />
            </Button>
          )}
          {goals.busy && (
            <Loader2
              className="size-4 animate-spin"
              aria-label={t("working")}
            />
          )}
        </div>
      )}
      {goals.error && (
        <p role="alert" className="py-1 text-xs text-destructive">
          {goals.error}
        </p>
      )}
      <Sheet open={editing} onOpenChange={setEditing}>
        <SheetContent
          showCloseButton={false}
          className="flex w-full flex-col sm:max-w-xl"
        >
          <SheetHeader>
            <SheetTitle>{t("edit")}</SheetTitle>
          </SheetHeader>
          <form
            className="flex flex-1 flex-col gap-4 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <FieldGroup className="flex-1">
              <Field className="flex-1">
                <Textarea
                  autoFocus
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  aria-label={t("objective")}
                  disabled={goals.busy}
                  className="min-h-48 flex-1"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void save();
                    }
                  }}
                />
              </Field>
            </FieldGroup>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditing(false)}
              >
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  goals.busy || !text.trim() || text.trim() === g?.objective
                }
              >
                {t("save")}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
      <Dialog open={resuming} onOpenChange={setResuming}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("resumeTitle")}</DialogTitle>
          </DialogHeader>
          <p className="line-clamp-4 whitespace-pre-wrap">{g?.objective}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResuming(false)}>
              {t("cancel")}
            </Button>
            <Button
              disabled={goals.busy}
              onClick={() => {
                void goals.execute("resume").then((ok) => {
                  if (ok) setResuming(false);
                });
              }}
            >
              {t("resume")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={goals.replacement !== null}
        onOpenChange={(open) => {
          if (!open) goals.resolveReplacement(false);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("replaceTitle")}</DialogTitle>
          </DialogHeader>
          <p className="line-clamp-4 whitespace-pre-wrap">
            {goals.replacement?.objective}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => goals.resolveReplacement(false)}
            >
              {t("cancel")}
            </Button>
            <Button onClick={() => goals.resolveReplacement(true)}>
              {t("replace")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
