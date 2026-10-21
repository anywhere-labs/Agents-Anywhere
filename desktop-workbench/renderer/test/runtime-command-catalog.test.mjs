import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true})
for(const key of ['window','document','navigator','HTMLElement','Element','Node'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]})
globalThis.IS_REACT_ACT_ENVIRONMENT=true
const hook=registerSource()
const {createElement:h,act,useLayoutEffect}=await import('react')
const {createRoot}=await import('react-dom/client')
const {dashboardApi}=await import('../src/features/dashboard/api.ts')
const {useRuntimeCommands,createRecoveredSubscriptionTracker}=await import('../src/components/session/use-runtime-commands.ts')
hook.deregister()

test('catalog invalidation, unavailable, reopen, stale response and fetch error are separate states',async t=>{
  const deferred=[]
  t.mock.method(dashboardApi,'getSessionCommands',async(_token,id)=>new Promise((resolve,reject)=>deferred.push({id,resolve,reject})))
  const host=document.createElement('div');document.body.append(host)
  const root=createRoot(host)
  const Host=props=>{const state=useRuntimeCommands({token:'token',...props});window.catalogState=state;return h('output',null,`${state.loading?'loading':state.error?'error':'ready'}:${state.commands.map(x=>x.id).join(',')}`)}
  const render=async props=>act(async()=>root.render(h(Host,props)))
  t.after(async()=>{await act(async()=>root.unmount());host.remove()})
  await render({sessionId:'a',open:true,available:true,catalogRevision:'1'})
  await act(async()=>delay(140))
  assert.equal(deferred.length,1)
  await render({sessionId:'b',open:true,available:true,catalogRevision:'1'})
  await act(async()=>deferred[0].resolve({commands:[{id:'stale'}]}))
  assert.doesNotMatch(host.textContent,/stale/)
  await act(async()=>delay(140))
  await act(async()=>deferred[1].resolve({commands:[{id:'live'}]}))
  assert.match(host.textContent,/ready:live/)
  await render({sessionId:'b',open:true,available:true,catalogRevision:'2'})
  await act(async()=>delay(140))
  await act(async()=>deferred[2].reject(new Error('offline')))
  assert.match(host.textContent,/error:/)
  await render({sessionId:'b',open:true,available:false,catalogRevision:'2'})
  assert.match(host.textContent,/ready:/)
  assert.equal(deferred.length,3)
  await render({sessionId:'b',open:false,available:true,catalogRevision:'2'})
  await render({sessionId:'b',open:true,available:true,catalogRevision:'2'})
  await act(async()=>delay(140))
  assert.equal(deferred.length,4)
})

test('successful subscription recovery refetches an open failed catalog despite unchanged revision and ignores stale requests',async t=>{
  const deferred=[]
  t.mock.method(dashboardApi,'getSessionCommands',async()=>new Promise((resolve,reject)=>deferred.push({resolve,reject})))
  const host=document.createElement('div');document.body.append(host)
  const root=createRoot(host)
  let generation=0
  const recovered=createRecoveredSubscriptionTracker(()=>{generation++})
  const Host=()=>{const state=useRuntimeCommands({token:'token',sessionId:'a',open:true,available:true,catalogRevision:'constant',recoveryGeneration:generation});return h('output',null,`${state.loading?'loading':state.error?'error':'ready'}:${state.commands.map(x=>x.id).join(',')}`)}
  const render=async()=>act(async()=>root.render(h(Host)))
  t.after(async()=>{await act(async()=>root.unmount());host.remove()})
  await render();await act(async()=>delay(140))
  recovered.observed(1)
  recovered.recovered(1)
  assert.equal(generation,0,'initial subscribed recovery is part of initial catalog read')
  await act(async()=>deferred[0].reject(new Error('disconnected')))
  assert.match(host.textContent,/error:/)
  recovered.observed(2);recovered.recovered(2);await render();await act(async()=>delay(140))
  assert.equal(deferred.length,2)
  recovered.recovered(2);await render();await act(async()=>delay(140))
  assert.equal(deferred.length,2,'duplicate subscribed recovery cannot refetch twice')
  recovered.observed(3);recovered.recovered(3);await render();await act(async()=>delay(140))
  assert.equal(deferred.length,3)
  await act(async()=>deferred[1].resolve({commands:[{id:'stale'}]}))
  assert.doesNotMatch(host.textContent,/stale/)
  await act(async()=>deferred[2].resolve({commands:[{id:'fresh'}]}))
  assert.match(host.textContent,/ready:fresh/)
})

test('first connection can fail before recovery and still invalidate after its reconnect',()=>{
  let changes=0
  const tracker=createRecoveredSubscriptionTracker(()=>changes++)
  tracker.observed(1)
  tracker.observed(2)
  tracker.recovered(2)
  tracker.recovered(2)
  assert.equal(changes,1)
})
test('switching session hides the old catalog before effects and requests the full catalog',async t=>{
  const requests=[];const commits=[]
  t.mock.method(dashboardApi,'getSessionCommands',async(_token,id,options)=>{requests.push({id,options});return {commands:[{id:`${id}-command`}]}})
  const host=document.createElement('div');document.body.append(host)
  const root=createRoot(host)
  const Host=({sessionId})=>{
    const state=useRuntimeCommands({token:'token',sessionId,open:true,available:true,catalogRevision:'same'})
    useLayoutEffect(()=>{commits.push({sessionId,commands:state.commands.map(x=>x.id)})})
    return h('output',null,state.commands.map(x=>x.id).join(','))
  }
  t.after(async()=>{await act(async()=>root.unmount());host.remove()})
  await act(async()=>root.render(h(Host,{sessionId:'a'})))
  await act(async()=>delay(140))
  assert.match(host.textContent,/a-command/)
  await act(async()=>root.render(h(Host,{sessionId:'b'})))
  assert.deepEqual(commits.find(x=>x.sessionId==='b').commands,[])
  await act(async()=>delay(140))
  assert.deepEqual(requests,[{id:'a',options:{limit:1000}},{id:'b',options:{limit:1000}}])
})
test('a status change refreshes native command availability even when catalog revision is unchanged',async t=>{
  const requested=[];let currentStatus='running'
  t.mock.method(dashboardApi,'getSessionCommands',async()=>{requested.push(currentStatus);return {commands:[{id:'compact',enabled:currentStatus==='idle'}]}})
  const host=document.createElement('div');document.body.append(host)
  const root=createRoot(host)
  const Host=({runtimeStatus})=>{const state=useRuntimeCommands({token:'token',sessionId:'a',open:true,available:true,catalogRevision:'constant',runtimeStatus});return h('output',null,state.commands[0]?.enabled?'enabled':'disabled')}
  t.after(async()=>{await act(async()=>root.unmount());host.remove()})
  await act(async()=>root.render(h(Host,{runtimeStatus:currentStatus})))
  await act(async()=>delay(140))
  assert.equal(host.textContent,'disabled')
  currentStatus='idle'
  await act(async()=>root.render(h(Host,{runtimeStatus:currentStatus})))
  await act(async()=>delay(140))
  assert.equal(host.textContent,'enabled')
  assert.deepEqual(requested,['running','idle'])
})
test.after(()=>dom.window.close())
