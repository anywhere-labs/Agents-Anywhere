import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSource } from './helpers/onboarding-source.mjs'

const hook = registerSource()
const { parseSlashIntent, commandRequest, commandAllowed, commandResult, commandTransportFailure } = await import('../src/components/session/runtime-command-model.ts')
const { ApiError } = await import('../src/lib/api/errors.ts')
hook.deregister()

const goal = { id: 'goal', aliases: [], enabled: true, disabledReason: null, acceptsArgs: true, argsSchema: {type:'string'}, metadata: { ui: {kind:'execute', acceptsMultiline:true, allowedStatuses:['idle','running']} } }

test('exact multiline raw and long free-form input remain one argument', () => {
  const raw = ` /goal create ${Array.from({length:40}, (_, i) => `word${i}`).join(' ')}\nsecond line  `
  const intent = parseSlashIntent(raw)
  assert.equal(intent?.command, 'goal')
  assert.equal(intent?.multiline, true)
  assert.deepEqual(commandRequest(intent, goal), { command:'goal', args:[raw.slice(raw.indexOf('create'))], raw })
})

test('unknown, unsupported multiline, busy and unavailable are not executable', () => {
  assert.equal(parseSlashIntent(' /missing hello')?.command, 'missing')
  assert.equal(commandAllowed(goal, 'running', true, true, true), true)
  assert.equal(commandAllowed(goal, 'blocked', true, true, true), false)
  assert.equal(commandAllowed(goal, 'idle', false, true, true), false)
  assert.equal(commandAllowed(goal, 'idle', true, false, true), false)
  assert.equal(commandAllowed(goal, 'idle', true, true, false), false)
  assert.equal(commandRequest(parseSlashIntent('/compact\nfoo'), {...goal, id:'compact', acceptsArgs:false, metadata:{ui:{kind:'execute',acceptsMultiline:false}}}), null)
})

test('outer failure overrides nested acknowledgement; unknown is never success', () => {
  assert.equal(commandResult({ok:false,code:'goal_pause_unknown',message:'uncertain',result:{ok:true,executionState:'unknown'}}).ok, false)
  assert.equal(commandResult({ok:false,code:'invalid_args',message:'Invalid arguments',result:{}}).state, 'completed')
  assert.equal(commandResult({ok:true,message:'queued',result:{executionState:'accepted'}}).state, 'accepted')
  assert.equal(commandResult({ok:true,message:'done',result:{executionState:'unknown'}}).ok, false)
})

test('pre-dispatch HTTP validation is a known rejection while network loss is unknown',()=>{
  assert.equal(commandTransportFailure(new ApiError({status:409,kind:'http',detail:'Capability unavailable',code:'command_unavailable'}),'fallback').state,'completed')
  assert.equal(commandTransportFailure(new ApiError({status:0,kind:'network',detail:'Connection lost'}),'fallback').state,'unknown')
})


// Without an explicit multiline opt-in, slash input must remain a command draft.
test('multiline requires an explicit execute opt-in, even with absent or selector metadata', () => {
  for (const metadata of [{}, {ui:{kind:'selector',target:'model'}}]) {
    assert.equal(commandRequest(parseSlashIntent('/goal create\nline two'), {...goal, metadata}), null)
  }
})

test('native result text is shown when the envelope has no descriptive message', () => {
  assert.equal(commandResult({ok:true,result:{executionState:'accepted',text:'Native  reply\nkept'}}).message,'Native  reply\nkept')
  assert.equal(commandResult({ok:false,message:'Native rejected',result:{executionState:'completed',text:'detail'}}).message,'Native rejected')
})

test('legacy commands without ui metadata execute while idle but do not opt in to busy or multiline execution',()=>{
  const legacy={id:'compact',title:'Compact',description:'Compact conversation history',aliases:[],category:null,scope:'session',enabled:true,disabledReason:null,acceptsArgs:false,argsSchema:null,metadata:{}}
  assert.equal(commandAllowed(legacy,'idle',true,true,true),true)
  assert.equal(commandAllowed(legacy,'error',true,true,true),true)
  assert.equal(commandAllowed(legacy,'running',true,true,true),false)
  assert.deepEqual(commandRequest(parseSlashIntent(' /compact  '),legacy),{command:'compact',args:[],raw:' /compact  '})
  assert.equal(commandRequest(parseSlashIntent('/compact\n'),legacy),null)
  for(const ui of [null,[],{kind:'unexpected'},{kind:'selector',target:'unexpected'}]){
    assert.equal(commandAllowed({...legacy,metadata:{ui}},'idle',true,true,true),false)
  }
})

test('a confirmation_required answer carries the plan and the follow-up arguments', async () => {
  const { commandConfirmation, confirmationArgs } = await import('../src/components/session/runtime-command-model.ts')
  const plan = { kind: 'owner_release', planId: 'p1', expiresAt: '2026-11-18T12:00:00.000Z', appName: 'Codex App', processCount: 2, releasesOtherSessions: true, gracePeriodMs: 5000,
    confirmArgs: ['--confirm', 'p1'], forceArgs: ['--confirm', 'p1', '--force'], cancelArgs: ['--cancel', 'p1'] }
  const confirmation = commandConfirmation({ ok: false, code: 'confirmation_required', result: { executionState: 'completed', confirmation: plan } })
  assert.deepEqual(confirmation, plan)
  assert.deepEqual(confirmationArgs(confirmation, 'confirm'), ['--confirm', 'p1'])
  assert.deepEqual(confirmationArgs(confirmation, 'force'), ['--confirm', 'p1', '--force'])
  assert.deepEqual(confirmationArgs(confirmation, 'cancel'), ['--cancel', 'p1'])
  assert.equal(confirmationArgs({ ...confirmation, forceArgs: [] }, 'force'), null)
  assert.equal(commandConfirmation({ ok: false, code: 'app_not_running', result: { confirmation: plan } }), null)
  assert.equal(commandConfirmation({ ok: true, code: 'confirmation_required', result: { confirmation: plan } }), null)
  assert.equal(commandConfirmation({ ok: false, code: 'confirmation_required', result: { confirmation: { ...plan, confirmArgs: [] } } }), null)
  assert.equal(commandConfirmation({ ok: false, code: 'confirmation_required', result: { confirmation: { ...plan, kind: 'other' } } }), null)
})
