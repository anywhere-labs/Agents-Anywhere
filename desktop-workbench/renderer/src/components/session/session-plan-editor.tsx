"use client"

import * as React from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { planMarkdownExtensions } from "./plan-markdown"
import type { PlanDraft } from "./plan-draft"
import "./session-plan-editor.css"

export function SessionPlanEditor({ draft, documentKey }: { draft: PlanDraft; documentKey: string }) {
  const t = useTranslations("dashboard.session")
  const snapshot = React.useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot)
  const editor = useEditor({
    extensions: planMarkdownExtensions,
    content: snapshot.text,
    contentType: "markdown",
    immediatelyRender: false,
    editable: snapshot.loaded,
    editorProps: { attributes: { class: "plan-document-content", role: "textbox", "aria-label": t("planDocument"), "aria-multiline": "true" } },
    onUpdate: ({ editor }) => { if (draft.getSnapshot().loaded) draft.update({ text: editor.getMarkdown() }) },
    onBlur: () => { void draft.flush() },
  }, [draft])
  React.useEffect(() => {
    if (!editor) return
    editor.setEditable(snapshot.loaded, false)
    if (snapshot.loaded && editor.getMarkdown() !== snapshot.text) {
      editor.commands.setContent(snapshot.text, { contentType: "markdown", emitUpdate: false })
    }
  }, [editor, snapshot.loaded])
  return (
    <div className="flex h-full min-h-0 flex-col" data-plan-document={documentKey}>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
        <span title={snapshot.path}>{t(`planSave_${snapshot.status}`)}</span>
        <span>{t("planDocumentHint")}</span>
      </div>
      {snapshot.error ? <div role="alert" className="border-b px-4 py-2 text-xs text-destructive">
        {snapshot.error}
        <Button size="sm" variant="ghost" onClick={() => { void draft.flush() }}>{t("planSaveRetry")}</Button>
      </div> : null}
      <div className="min-h-0 flex-1 overflow-auto"><EditorContent editor={editor} /></div>
    </div>
  )
}
