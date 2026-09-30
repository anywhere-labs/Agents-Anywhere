import assert from "node:assert/strict"
import test from "node:test"
import { createPlanDraft } from "../src/components/session/plan-draft.ts"
import { Editor } from "@tiptap/core"
import { planMarkdownExtensions } from "../src/components/session/plan-markdown.ts"
import { JSDOM } from "jsdom"

function storage() {
  let text = null
  let version = ""
  return {
    read: async () => ({text,version,path:"plan.md"}),
    write: async (content, expected) => {
      assert.equal(expected,version)
      text=content; version=String(Number(version)+1)
      return version
    },
  }
}

test("document survives reopening and remains editable after approval snapshot", async () => {
  const disk=storage()
  const document=createPlanDraft("# Original",disk)
  await document.initialize()
  assert.equal(document.getSnapshot().status,"saved")
  const approved=document.getSnapshot().text
  document.update({text:"# Changed after approval"})
  await document.flush()
  const reopened=createPlanDraft("# Old notice",disk)
  await reopened.initialize()
  assert.equal(reopened.getSnapshot().text,"# Changed after approval")
  assert.equal(approved,"# Original")
})

test("serialized saves retain typing that arrives during a pending write", async () => {
  const disk=storage()
  const document=createPlanDraft("# Original",disk)
  await document.initialize()
  let release
  const originalWrite=disk.write
  disk.write=async (...args)=>{await new Promise(resolve=>{release=resolve});return originalWrite(...args)}
  document.update({text:"# First"})
  const saving=document.flush()
  await Promise.resolve(); await Promise.resolve()
  document.update({text:"# Latest"})
  disk.write=originalWrite
  release()
  await saving
  assert.equal((await disk.read()).text,"# Latest")
  assert.equal(document.getSnapshot().status,"saved")
})

test("save failure retains edits and retry uses the last successful revision", async () => {
  const disk=storage()
  const document=createPlanDraft("# Original",disk)
  await document.initialize()
  const originalWrite=disk.write
  disk.write=async()=>{throw new Error("offline")}
  document.update({text:"# Unsaved"})
  assert.equal(await document.flush(),false)
  assert.equal(document.getSnapshot().text,"# Unsaved")
  assert.equal(document.getSnapshot().status,"error")
  disk.write=originalWrite
  assert.equal(await document.flush(),true)
  assert.equal((await disk.read()).text,"# Unsaved")
})

test("load failure cannot overwrite an existing file and can be retried", async () => {
  const disk=storage()
  await disk.write("# Existing","")
  const read=disk.read
  disk.read=async()=>{throw new Error("offline")}
  const document=createPlanDraft("# Stale notice",disk)
  await assert.rejects(document.initialize(),/offline/)
  assert.equal(document.getSnapshot().loaded,false)
  disk.read=read
  assert.equal(await document.flush(),true)
  assert.equal(document.getSnapshot().text,"# Existing")
})

test("rich editor renders Markdown and serializes formatted content after direct editing", () => {
  const dom=new JSDOM("<!doctype html><div id='editor'></div>")
  const names=["window","document","navigator","Node","HTMLElement","MutationObserver","getComputedStyle"]
  const old=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]))
  for(const name of names)Object.defineProperty(globalThis,name,{configurable:true,value:name==="getComputedStyle"?dom.window.getComputedStyle.bind(dom.window):dom.window[name]})
  const markdown="# Title\n\n## Goal\n\nA **bold** plan with [link](https://example.com).\n\n- first\n- second\n\n- [x] completed\n\n| Step | Status |\n| --- | --- |\n| test | done |\n\n```ts\nconst ready = true\n```"
  let editor
  try {
    editor=new Editor({element:document.getElementById("editor"),extensions:planMarkdownExtensions,content:markdown,contentType:"markdown"})
    assert.equal(document.querySelector("h1").textContent,"Title")
    assert.ok(document.querySelector("strong"))
    assert.ok(document.querySelector("table"))
    assert.ok(document.querySelector('input[type="checkbox"]'))
    assert.ok(document.querySelector('[contenteditable="true"]'))
    editor.commands.insertContentAt(1,"Edited ")
    const saved=editor.getMarkdown()
    assert.match(saved,/# Edited Title/)
    assert.match(saved,/\*\*bold\*\*/)
    assert.match(saved,/\[x\]/)
    assert.match(saved,/\| Step/)
    assert.match(saved,/```ts/)
    assert.match(saved,/const ready = true/)
    editor.commands.undo()
    assert.equal(document.querySelector("h1").textContent,"Title")
  } finally {
    editor?.destroy();dom.window.close()
    for(const [name,descriptor] of old)descriptor?Object.defineProperty(globalThis,name,descriptor):delete globalThis[name]
  }
})
