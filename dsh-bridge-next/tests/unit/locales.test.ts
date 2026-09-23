import assert from 'node:assert/strict'
import test from 'node:test'
import { en, zh, translateMessage, type LocaleKey, type Translate } from '../../src/client/locales.ts'

const translate = (dictionary: Record<LocaleKey, string>): Translate => (key, params) =>
  dictionary[key as LocaleKey].replace(/\{(\w+)\}/g, (match, name: string) => params && name in params ? String(params[name]) : match)

test('English preserves interpolation parameters for every Chinese message', () => {
  for (const key of Object.keys(en) as LocaleKey[]) {
    assert.deepEqual([...en[key].matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort(),
      [...zh[key].matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort(), key)
    assert.doesNotMatch(en[key], /\p{Script=Han}/u, key)
  }
})

test('stored Host failures translate at render time without changing raw diagnostics', () => {
  const chinese = translate(zh)
  const english = translate(en)
  const failure = '无法撤销设备连接。服务请求失败（HTTP 503），请重试。'
  assert.equal(translateMessage(chinese, failure), failure)
  assert.equal(translateMessage(english, failure), 'Unable to revoke the device connection. The service request failed (HTTP 503). Try again.')
  const stopped = 'Connector 已退出（终止）。请在日志页切换到 Connector 查看原因。'
  assert.equal(translateMessage(chinese, stopped), stopped)
  assert.match(translateMessage(english, stopped), /Connector exited \(terminated\)/)
  assert.equal(translateMessage(english, 'ENOENT: /用户/工作目录'), 'ENOENT: /用户/工作目录')
  assert.equal(english('{name}请求连接此账号', { name: '小王的手机' }), '小王的手机 wants to connect to this account')
})
