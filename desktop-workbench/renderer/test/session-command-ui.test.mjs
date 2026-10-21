import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url:'https://app.example.test/', pretendToBeVisual:true })
for (const key of ['window','document','navigator','HTMLElement','HTMLTextAreaElement','HTMLFormElement','HTMLInputElement','DocumentFragment','CustomEvent','Element','Node','MutationObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) {
  Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]})
}
globalThis.ResizeObserver = class {observe(){} disconnect(){}}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const hook = registerSource()
const { createElement:h, act, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const { SessionComposer } = await import('../src/components/session/session-composer.tsx')
const { dashboardApi } = await import('../src/features/dashboard/api.ts')
const { toast } = await import('sonner')
hook.deregister()
// Successful command feedback is a transient toast; collect it instead of rendering a Toaster.
const toasts=[]
toast.success=(title,options)=>{toasts.push(`${title}\n${options?.description??''}`)}
const toastText=()=>toasts.join('\n')
const messages = JSON.parse(readFileSync(new URL('../messages/en.json',import.meta.url),'utf8'))
const session = {id:'s1',runtime:'codex',runtimeId:'codex',connectorStatus:'online',status:'idle',archived:false,takeover:true}
const capability = {revision:1,capabilities:[{capabilityId:'session.commands',scope:'session',runtime:'codex',runtimeId:'codex',sessionId:'s1',supported:true,available:true,allowed:true},{capabilityId:'session.interrupt',scope:'session',runtime:'codex',runtimeId:'codex',sessionId:'s1',supported:true,available:true,allowed:true},{capabilityId:'session.send_message',scope:'session',runtime:'codex',runtimeId:'codex',sessionId:'s1',supported:true,available:true,allowed:true}]}
const descriptor = (id, acceptsArgs, statuses=['idle']) => ({id,title:id,description:'native',aliases:[],scope:'session',enabled:true,disabledReason:null,acceptsArgs,argsSchema:{type:'string'},metadata:{ui:{kind:'execute',acceptsMultiline:true,allowedStatuses:statuses}}})

async function mount(t, child) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(h(NextIntlClientProvider,{locale:'en',messages,timeZone:'UTC'},child)))
  t.after(async () => {await act(async () => root.unmount());host.remove()})
  return host
}
const textSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set

async function type(input,value) {await act(async()=>{textSetter.call(input,value);input.dispatchEvent(new window.Event('input',{bubbles:true}))})}

test('composer inserts argument command, submits exact long raw once, preserves new typing after delayed accepted result', async t => {
  let resolve
  const calls=[];let messagesSent=0
  function Host() {
    const [value,setValue] = useState('/')
    return h(SessionComposer,{token:'test',session,runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:[descriptor('goal',true)],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>{messagesSent++;return true},onInterrupt(){},onToggleTakeover(){},onCommand:(id,payload)=>{calls.push({id,payload});return new Promise(done=>resolve=done)}})
  }
  const host=await mount(t,h(Host))
  const menu=[...host.querySelectorAll('button')].find(button=>button.textContent.includes('/goal'))
  assert.ok(menu)
  await act(async()=>menu.click())
  const input=host.querySelector('textarea')
  assert.equal(input.value,'/goal ')
  assert.equal(document.activeElement,input)
  assert.equal(calls.length,0)
  const raw=` /goal create ${Array.from({length:40},(_,i)=>`word${i}`).join(' ')}\nsecond line  `
  await type(input,raw)
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.equal(calls.length,1)
  assert.equal(calls[0].payload.raw,raw)
  assert.equal(calls[0].payload.args.length,1)
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.equal(calls.length,1)
  await type(input,'/goal status')
  await act(async()=>resolve({ok:true,state:'accepted',message:'Queued',code:null,result:{executionState:'accepted'}}))
  assert.equal(input.value,'/goal status')
  assert.match(toastText(),/Queued/)
  assert.doesNotMatch(host.textContent,/Queued/)
  assert.equal(messagesSent,0)
})

test('an old command acknowledgement cannot clear or report against the newly selected session',async t=>{
  let resolve
  function Host(){const [selected,setSelected]=useState(session);const [value,setValue]=useState('/compact');window.switchCommandSession=()=>{setSelected({...session,id:'s2'});setValue('new session draft')};return h(SessionComposer,{token:'test',session:selected,runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:[descriptor('compact',false)],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>true,onInterrupt(){},onToggleTakeover(){},onCommand:async()=>new Promise(done=>resolve=done)})}
  const host=await mount(t,h(Host));const input=host.querySelector('textarea')
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  await act(async()=>window.switchCommandSession())
  await act(async()=>resolve({ok:true,state:'accepted',code:null,message:'old session accepted',result:{executionState:'accepted'}}))
  assert.equal(input.value,'new session draft')
  assert.doesNotMatch(host.textContent,/old session accepted/)
  assert.doesNotMatch(toastText(),/old session accepted/)
})

test('menu execution preserves resolved raw, clears unchanged source draft, and never model-sends',async t=>{
  const variants=[
    {draft:'/',raw:'/compact',menu:true},
    {draft:'/com',raw:'/compact',menu:true},
    {draft:' /SHORT  ',raw:' /SHORT  ',menu:false},
    {draft:' /COMPACT  ',raw:' /COMPACT  ',menu:false},
  ]
  for(const variant of variants){
    let sent=0;const calls=[]
    function Host(){const [value,setValue]=useState(variant.draft);return h(SessionComposer,{token:'test',session,runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:[{...descriptor('compact',false),aliases:['short']}],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>{sent++;return true},onInterrupt(){},onToggleTakeover(){},onCommand:async(id,payload)=>{calls.push({id,payload});return {ok:true,state:'completed',message:'done'}}})}
    const host=await mount(t,h(Host))
    const menu=host.querySelector('[role=option]')
    assert.equal(Boolean(menu),variant.menu,variant.draft)
    if(menu) await act(async()=>menu.click())
    else await act(async()=>host.querySelector('textarea').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
    assert.deepEqual(calls.map(({id,payload})=>({id,raw:payload.raw})),[{id:'compact',raw:variant.raw}])
    assert.equal(host.querySelector('textarea').value,'',variant.draft)
    assert.equal(sent,0)
  }
})

test('menu completion cannot clear newer typing and failure or unknown retain the original draft',async t=>{
  for(const state of ['completed','unknown','failed']){
    let resolve;let sent=0
    function Host(){const [value,setValue]=useState('/com');return h(SessionComposer,{token:'test',session,runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:[descriptor('compact',false)],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>{sent++;return true},onInterrupt(){},onToggleTakeover(){},onCommand:async()=>new Promise(done=>resolve=done)})}
    const host=await mount(t,h(Host));const input=host.querySelector('textarea')
    await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent.includes('/compact')).click())
    if(state==='completed') await type(input,'new draft')
    await act(async()=>resolve({ok:state==='completed',state:state==='failed'?'completed':state,message:state}))
    assert.equal(input.value,state==='completed'?'new draft':'/com')
    assert.equal(sent,0)
  }
})

test('A to B to A invalidates command1 while command2 remains pending',async t=>{
  const pending=[]
  function Host(){const [selected,setSelected]=useState(session);const [value,setValue]=useState('/compact');window.visitB=()=>{setSelected({...session,id:'s2'});setValue('B draft')};window.visitA=()=>{setSelected(session);setValue('/compact')};return h(SessionComposer,{token:'test',session:selected,runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:[descriptor('compact',false)],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>true,onInterrupt(){},onToggleTakeover(){},onCommand:async()=>new Promise(resolve=>pending.push(resolve))})}
  const host=await mount(t,h(Host));const input=host.querySelector('textarea')
  const enter=async()=>act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  await enter();assert.equal(pending.length,1)
  await act(async()=>window.visitB())
  await act(async()=>window.visitA())
  await enter();assert.equal(pending.length,2)
  await act(async()=>pending[0]({ok:true,state:'completed',message:'old result'}))
  assert.equal(input.value,'/compact')
  assert.doesNotMatch(host.textContent,/old result/)
  assert.doesNotMatch(toastText(),/old result/)
  await enter();assert.equal(pending.length,2,'old finally must not release command2')
  await act(async()=>pending[1]({ok:true,state:'completed',message:'new result'}))
  assert.equal(input.value,'')
  assert.match(toastText(),/new result/)
})

test('slash text that is not a catalog command is sent as a message; unsupported multiline and native ok:false retain the draft',async t=>{
  let sent=0;let calls=0
  function Host(){const [value,setValue]=useState('/missing what');return h(SessionComposer,{token:'test',session,runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:[descriptor('compact',false)],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>{sent++;return true},onInterrupt(){},onToggleTakeover(){},onCommand:async()=>{calls++;return {ok:false,state:'completed',code:'command_error',message:'native rejected',result:{executionState:'completed'}}}})}
  const host=await mount(t,h(Host));const input=host.querySelector('textarea')
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.equal(sent,1)
  assert.equal(host.querySelector('[role=alert]'),null)
  await type(input,'/Users/me/notes.md explain this')
  assert.equal(host.querySelector('[role=listbox]'),null)
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.equal(sent,2)
  await type(input,'/compact\ninvalid')
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.ok(host.querySelector('[role=alert]'))
  assert.match(host.querySelector('[role=alert]').textContent,/does not accept multiple lines/)
  assert.equal(input.value,'/compact\ninvalid')
  await type(input,'/compact')
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.equal(calls,1)
  assert.equal(input.value,'/compact')
  assert.match(host.textContent,/native rejected/)
  await act(async()=>host.querySelector('[aria-label=Dismiss]').click())
  assert.doesNotMatch(host.textContent,/native rejected/)
  assert.equal(input.value,'/compact')
  assert.equal(sent,2)
})

test('read-only slash command remains unavailable while draft is intact',async t=>{
  let executed=0
  function Host(){const [value,setValue]=useState('/compact');return h(SessionComposer,{token:'test',session:{...session,takeover:false},runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:[descriptor('compact',false)],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>true,onInterrupt(){},onToggleTakeover(){},onCommand:async()=>{executed++;return {ok:true,state:'accepted'}}})}
  const host=await mount(t,h(Host));const input=host.querySelector('textarea')
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.equal(executed,0)
  assert.equal(input.value,'/compact')
  assert.ok(host.querySelector('[role=alert]'))
  assert.match(host.querySelector('[role=alert]').textContent,/takeover/)
})

test('menu shows the block reason inline and keyboard selects, completes, runs and dismisses',async t=>{
  const calls=[]
  const commands=[descriptor('compact',false),descriptor('goal',true,['idle','running']),descriptor('config',false)]
  function Host(){const [value,setValue]=useState('/');return h(SessionComposer,{token:'test',session,runtimeState:{status:'running',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:commands,onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>assert.fail('command is not a message'),onInterrupt(){},onToggleTakeover(){},onCommand:async(id,payload)=>{calls.push({id,raw:payload.raw});return {ok:true,state:'accepted',message:null}}})}
  const host=await mount(t,h(Host));const input=host.querySelector('textarea')
  const key=async name=>act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:name,bubbles:true})))
  const options=()=>[...host.querySelectorAll('[role=option]')]
  const selected=()=>options().find(option=>option.getAttribute('aria-selected')==='true')
  assert.equal(options().length,3)
  assert.match(options()[0].textContent,/busy/)
  assert.equal(options()[0].getAttribute('aria-disabled'),'true')
  assert.equal(input.getAttribute('aria-expanded'),'true')
  await key('Enter')
  assert.equal(calls.length,0,'a blocked command does not run')
  await key('ArrowUp')
  assert.match(selected().textContent,/\/config/)
  await key('ArrowDown');await key('ArrowDown')
  assert.match(selected().textContent,/\/goal/)
  await key('Tab')
  assert.equal(input.value,'/goal ')
  assert.equal(host.querySelector('[role=listbox]'),null)
  await type(input,'/go')
  await key('Escape')
  assert.equal(host.querySelector('[role=listbox]'),null)
  assert.equal(input.value,'/go')
  await type(input,'/goa')
  assert.ok(host.querySelector('[role=listbox]'),'typing again reopens the menu')
  await key('Enter')
  assert.equal(input.value,'/goal ','an argument command completes instead of running')
  await type(input,'/goal ship it')
  await key('Enter')
  assert.deepEqual(calls,[{id:'goal',raw:'/goal ship it'}])
})

test('successful command feedback is a toast, not inline',async t=>{
  toasts.length=0
  function Host(){const [value,setValue]=useState('/compact');return h(SessionComposer,{token:'test',session,runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:[descriptor('compact',false)],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>true,onInterrupt(){},onToggleTakeover(){},onCommand:async()=>({ok:true,state:'completed',message:'compacted'})})}
  const host=await mount(t,h(Host));const input=host.querySelector('textarea')
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.match(toastText(),/compacted/)
  assert.doesNotMatch(host.textContent,/compacted/)
})

test('a bare slash explains why a session cannot run commands and still sends other text',async t=>{
  const unsupported={revision:1,capabilities:[...capability.capabilities.filter(item=>item.capabilityId!=='session.commands'),{capabilityId:'session.commands',scope:'session',runtime:'codex',runtimeId:'codex',sessionId:'s1',supported:false,available:false,allowed:false,unavailableReason:'Upgrade the bridge.'}]}
  let sent=0
  function Host(){const [value,setValue]=useState('/');return h(SessionComposer,{token:'test',session,runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:unsupported,modelCatalog:null,permissionCatalog:null,runtimeCommands:[],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>{sent++;return true},onInterrupt(){},onToggleTakeover(){},onCommand:async()=>assert.fail('commands are unavailable')})}
  const host=await mount(t,h(Host));const input=host.querySelector('textarea')
  assert.match(host.querySelector('[role=status]').textContent,/does not support commands/)
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  assert.equal(host.querySelector('[role=status]'),null)
  await type(input,'/hello there')
  assert.equal(host.querySelector('[role=status]'),null)
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.equal(sent,1)
})

test('selector command with no available native settings control reports unavailable without dispatch',async t=>{
  let executed=0
  const model={...descriptor('model',false),metadata:{ui:{kind:'selector',target:'model'}}}
  const host=await mount(t,h(SessionComposer,{token:'test',session,runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value:'/model',effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:[model],onCommandQueryChange(){},onValueChange(){},onSelectionChange:async()=>true,onSend:async()=>true,onInterrupt(){},onToggleTakeover(){},onCommand:async()=>{executed++;return {ok:true,state:'accepted'}}}))
  await act(async()=>host.querySelector('textarea').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.ok(host.querySelector('[role=alert]'))
  assert.match(host.querySelector('[role=alert]').textContent,/unavailable/)
  assert.equal(executed,0)
})

test('a slash command in a running turn presents Send and dispatches the command rather than Stop',async t=>{
  let stopped=0;const calls=[]
  function Host(){const [value,setValue]=useState('/goal status');return h(SessionComposer,{token:'test',session,runtimeState:{status:'running',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:[descriptor('goal',true,['running'])],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>true,onInterrupt(){stopped++},onToggleTakeover(){},onCommand:async(id,payload)=>{calls.push({id,payload});return {ok:true,state:'accepted',message:'accepted'}}})}
  const host=await mount(t,h(Host));const button=host.querySelector('button[aria-label="Send"]')
  assert.ok(button)
  await act(async()=>button.click())
  assert.equal(stopped,0)
  assert.deepEqual(calls.map(({id,payload})=>({id,raw:payload.raw})),[{id:'goal',raw:'/goal status'}])
})

test('permission selector opens the existing drawer, preserves Auto review badge, and never executes a native command',async t=>{
  const selections=[];let executed=0
  const dshSession={...session,runtime:'dsh',runtimeId:'dsh'}
  const caps={revision:1,capabilities:['session.commands','catalog.permission'].map(capabilityId=>({capabilityId,scope:'session',runtime:'dsh',runtimeId:'dsh',sessionId:'s1',supported:true,available:true,allowed:true}))}
  const permissionCatalog={runtime:'dsh',revision:1,permissions:[
    {id:'auto',displayName:'auto',selectionId:'auto-selection',enabled:true,metadata:{preset:'auto'}},
    {id:'workspace',displayName:'Workspace',selectionId:'workspace-selection',enabled:true,metadata:{preset:'workspace-write'}},
  ]}
  const command={...descriptor('permission',false),metadata:{ui:{kind:'selector',target:'permission'}}}
  const host=await mount(t,h(SessionComposer,{token:'test',session:dshSession,runtimeState:{status:'idle',metadata:{},selections:{permission:'auto-selection'}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value:'/permission',effectiveCapabilities:caps,modelCatalog:null,permissionCatalog,runtimeCommands:[command],onCommandQueryChange(){},onValueChange(){},onSelectionChange:async patch=>{selections.push(patch);return true},onSend:async()=>assert.fail('selector is not a prompt'),onInterrupt(){},onToggleTakeover(){},onCommand:async()=>{executed++;return {ok:true,state:'completed'}}}))
  await act(async()=>host.querySelector('textarea').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  const drawer=document.querySelector('[role=dialog]')
  assert.ok(drawer)
  const auto=[...drawer.querySelectorAll('button')].find(button=>button.textContent.includes('Auto review'))
  assert.ok(auto)
  assert.match(auto.textContent,/EXP/)
  const workspace=[...drawer.querySelectorAll('button')].find(button=>button.textContent.includes('Workspace Write'))
  assert.ok(workspace)
  await act(async()=>workspace.click())
  assert.deepEqual(selections,[{permission:'workspace-selection'}])
  assert.equal(executed,0)
})

for (const width of [360, 900]) {
  for (const target of ['model', 'reasoning', 'permission']) {
    test(`/${target} opens usable existing settings at ${width}px and retains Auto review`, async t => {
      t.mock.method(HTMLElement.prototype, 'getBoundingClientRect', () => ({
        width, height: 200, x: 0, y: 0, top: 0, right: width, bottom: 200, left: 0,
      }))
      const selections = []
      const dshSession = { ...session, runtime: 'dsh', runtimeId: 'dsh' }
      const caps = {
        revision: 1,
        capabilities: ['session.commands', 'catalog.model', 'catalog.effort', 'catalog.permission'].map(capabilityId => ({
          capabilityId, scope: 'session', runtime: 'dsh', runtimeId: 'dsh', sessionId: 's1',
          supported: true, available: true, allowed: true,
        })),
      }
      const modelCatalog = { runtime: 'dsh', revision: 1, models: [{
        id: 'model-a', displayName: 'Model A', selectionId: 'model-a-low', enabled: true, metadata: {},
        reasoningItems: [
          { id: 'low', displayName: 'Low', selectionId: 'model-a-low', enabled: true, metadata: {} },
          { id: 'high', displayName: 'High', selectionId: 'model-a-high', enabled: true, metadata: {} },
        ],
      }] }
      const permissionCatalog = { runtime: 'dsh', revision: 1, permissions: [
        { id: 'auto', displayName: 'auto', selectionId: 'auto-selection', enabled: true, metadata: { preset: 'auto' } },
        { id: 'workspace', displayName: 'Workspace', selectionId: 'workspace-selection', enabled: true, metadata: { preset: 'workspace-write' } },
      ] }
      const command = { ...descriptor(target, false), metadata: { ui: { kind: 'selector', target } } }
      const host = await mount(t, h(SessionComposer, {
        token: 'test', session: dshSession,
        runtimeState: { status: 'idle', metadata: {}, selections: { model: 'model-a-low', permission: 'auto-selection' } },
        pendingInteractionCount: 0, sending: false, interrupting: false, takeoverBusy: false,
        value: `/${target}`, effectiveCapabilities: caps, modelCatalog, permissionCatalog,
        runtimeCommands: [command], onCommandQueryChange() {}, onValueChange() {},
        onSelectionChange: async patch => { selections.push(patch); return true },
        onSend: async () => assert.fail('selector is not a prompt'),
        onInterrupt() {}, onToggleTakeover() {},
        onCommand: async () => assert.fail('selector must use an existing selection control'),
      }))
      const settingsButton = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Settings')
      assert.equal(Boolean(settingsButton()), width < 560, 'exercise the actual responsive layout before the command')
      await act(async () => host.querySelector('textarea').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
      const drawer = document.querySelector('[role=dialog]')
      assert.ok(drawer)
      const auto = [...drawer.querySelectorAll('button')].find(button => button.textContent.includes('Auto review'))
      assert.ok(auto)
      assert.match(auto.textContent, /EXP/)
      if (target === 'permission') {
        const workspace = [...drawer.querySelectorAll('button')].find(button => button.textContent.includes('Workspace Write'))
        assert.ok(workspace)
        await act(async () => workspace.click())
        assert.deepEqual(selections, [{ permission: 'workspace-selection' }])
      } else {
        const model = [...drawer.querySelectorAll('button')].find(button => button.textContent.includes('Model A'))
        assert.ok(model)
        await act(async () => model.click())
        const high = [...drawer.querySelectorAll('button')].find(button => button.textContent === 'High')
        assert.ok(high)
        await act(async () => high.click())
        assert.deepEqual(selections, [{ model: 'model-a-high' }])
      }
      assert.equal(Boolean(settingsButton()), width < 560, 'restore the responsive controls after selection')
    })
  }
}

test('a slash command with an attachment retains both without invoking command or message send',async t=>{
  let executed=0;let sent=0
  t.mock.method(dashboardApi,'uploadSessionAttachments',async()=>({attachments:[{fileId:'file-1',filename:'notes.txt',size:5,mediaType:'text/plain'}]}))
  const caps={...capability,capabilities:[...capability.capabilities,{capabilityId:'runtime.attachment',scope:'session',runtime:'codex',runtimeId:'codex',sessionId:'s1',supported:true,available:true,allowed:true}]}
  function Host(){const [value,setValue]=useState('/compact');return h(SessionComposer,{token:'test',session,runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:caps,modelCatalog:null,permissionCatalog:null,runtimeCommands:[descriptor('compact',false)],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>{sent++;return true},onInterrupt(){},onToggleTakeover(){},onCommand:async()=>{executed++;return {ok:true,state:'accepted'}}})}
  const host=await mount(t,h(Host));const input=host.querySelector('textarea')
  const file=new window.File(['hello'],'notes.txt',{type:'text/plain'})
  const paste=new window.Event('paste',{bubbles:true,cancelable:true})
  Object.defineProperty(paste,'clipboardData',{value:{items:[{kind:'file',getAsFile:()=>file}]}})
  await act(async()=>window.dispatchEvent(paste))
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.match(host.textContent,/Remove attachments before running a command/)
  assert.match(host.textContent,/notes.txt/)
  assert.equal(input.value,'/compact')
  assert.equal(executed,0)
  assert.equal(sent,0)
})

test('accepted, completed and unknown feedback remain distinct and unknown does not retry automatically',async t=>{
  for(const [state,expected] of [['accepted','Command accepted; background work may still be running.'],['completed','Command completed.'],['unknown','The result is unknown. Check the session before trying again.']]){
    let calls=0
    function Host(){const [value,setValue]=useState('/compact');return h(SessionComposer,{token:'test',session,runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:[descriptor('compact',false)],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>assert.fail('command is not a message'),onInterrupt(){},onToggleTakeover(){},onCommand:async()=>{calls++;return {ok:state!=='unknown',state,message:'Native  result\nkept',result:{executionState:state}}}})}
    const host=await mount(t,h(Host));const input=host.querySelector('textarea')
    toasts.length=0
    await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
    const shown=state==='unknown'?host.textContent:toastText()
    assert.ok(shown.includes(expected))
    assert.ok(shown.includes('Native  result\nkept'))
    assert.equal(input.value,state==='unknown'?'/compact':'')
    await act(async()=>Promise.resolve())
    assert.equal(calls,1)
  }
})
test('legacy runtime commands still execute without metadata.ui',async t=>{
  const calls=[]
  const legacy={id:'compact',title:'Compact',description:'Compact conversation history',aliases:[],category:null,scope:'session',enabled:true,disabledReason:null,acceptsArgs:false,argsSchema:null,metadata:{}}
  function Host(){const [value,setValue]=useState('/compact');return h(SessionComposer,{token:'test',session,runtimeState:{status:'idle',metadata:{},selections:{}},pendingInteractionCount:0,sending:false,interrupting:false,takeoverBusy:false,value,effectiveCapabilities:capability,modelCatalog:null,permissionCatalog:null,runtimeCommands:[legacy],onCommandQueryChange(){},onValueChange:setValue,onSelectionChange:async()=>true,onSend:async()=>assert.fail('legacy command is not a message'),onInterrupt(){},onToggleTakeover(){},onCommand:async(id,payload)=>{calls.push({id,payload});return {ok:true,state:'accepted',message:null,result:null}}})}
  const host=await mount(t,h(Host));const input=host.querySelector('textarea')
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.deepEqual(calls,[{id:'compact',payload:{args:[],raw:'/compact'}}])
  assert.equal(input.value,'')
})
test.after(()=>dom.window.close())
