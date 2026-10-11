import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSource } from './helpers/onboarding-source.mjs'
const hook=registerSource()
const {DashboardApi}=await import('../src/features/dashboard/api.ts')
hook.deregister()

test('steerSessionMessage posts the running-turn steer payload beside the queued message endpoint',async()=>{
  const requests=[]
  const client={post:async(path,body)=>{requests.push({path,body});return {ok:true,code:null,message:null,result:null}}}
  const api=new DashboardApi(client)
  await api.sendSessionMessage('token','s1','next turn',{clientMessageId:'msg-queue'})
  await api.steerSessionMessage('token','s1','make it faster',{clientMessageId:'msg-1'})
  await api.steerSessionMessage('token','s1','plain')
  await api.steerSessionMessage('token','s1','with file',{attachments:[{fileId:'f1'}],clientMessageId:'msg-2'})
  assert.deepEqual(requests[0],{path:'/sessions/s1/runtime/messages',body:{content:'next turn',clientMessageId:'msg-queue'}})
  assert.deepEqual(requests[1],{path:'/sessions/s1/runtime/steer',body:{content:'make it faster',clientMessageId:'msg-1'}})
  assert.deepEqual(requests[2],{path:'/sessions/s1/runtime/steer',body:{content:'plain'}})
  assert.deepEqual(requests[3],{path:'/sessions/s1/runtime/steer',body:{content:'with file',attachments:[{fileId:'f1'}],clientMessageId:'msg-2'}})
})
