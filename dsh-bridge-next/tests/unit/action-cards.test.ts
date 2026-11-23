import assert from 'node:assert/strict'
import test from 'node:test'
import { withoutActionCards } from '../../src/host/dsh-runtime/action-cards.js'

const card = '{"action":"enable_official_plugin","title":"思考翻译","brief":"把显示的思考过程翻译成中文。","details":{"name":"thinking-translation"}}'

test('answers drop their trailing action-card block and the blank lines before it', () => {
  const answer = `思考翻译插件可以把显示的思考过程翻译成中文。\n\n点击下方「启用」即可。\n\n\`\`\`action-card\n${card}\n\`\`\`\n`
  assert.equal(withoutActionCards(answer), '思考翻译插件可以把显示的思考过程翻译成中文。\n\n点击下方「启用」即可。')
})

test('text without a card block is returned unchanged, including other fences and trailing whitespace', () => {
  for (const text of ['普通回复\n\n', '```ts\nconst x = 1\n```\n', 'action-card 这个词出现在正文里', '```action-cards\n{}\n```']) {
    assert.equal(withoutActionCards(text), text)
  }
})

test('the language is matched like DSH: lowercased first word of the info string, backtick or tilde fences', () => {
  assert.equal(withoutActionCards(`前文\n\`\`\`Action-Card json\n${card}\n\`\`\``), '前文')
  assert.equal(withoutActionCards(`前文\n~~~action-card\n${card}\n~~~`), '前文')
  // A longer fence closes only at a line at least as long.
  assert.equal(withoutActionCards(`前文\n\`\`\`\`action-card\n\`\`\`\n${card}\n\`\`\`\`\n后文`), '前文\n后文')
  // A backtick fence cannot carry a backtick in its info string, so this line opens no block.
  assert.equal(withoutActionCards('```action-card`\n{}'), '```action-card`\n{}')
})

test('blocks DSH does not read as cards are kept', () => {
  const nested = `\`\`\`\`markdown\n\`\`\`action-card\n${card}\n\`\`\`\n\`\`\`\``
  const quoted = `> \`\`\`action-card\n> ${card}\n> \`\`\``
  const indented = `    \`\`\`action-card\n    ${card}\n    \`\`\``
  for (const text of [nested, quoted, indented]) assert.equal(withoutActionCards(text), text)
})

test('a block in a middle or list position is removed with its fence lines; other lines keep their endings', () => {
  assert.equal(withoutActionCards(`前文\r\n\`\`\`action-card\r\n${card}\r\n\`\`\`\r\n后文\r\n`), '前文\r\n后文')
  assert.equal(withoutActionCards(`- 第一项\n- \`\`\`action-card\n  ${card}\n  \`\`\`\n- 第三项`), '- 第一项\n- 第三项')
})

test('an unclosed block runs to the end, so a streaming answer never shows partial card JSON', () => {
  assert.equal(withoutActionCards('前文\n\n```action-card'), '前文')
  assert.equal(withoutActionCards('前文\n\n```action-card\n{"action":"enable_'), '前文')
  assert.equal(withoutActionCards(`\`\`\`action-card\n${card}\n\`\`\``), '')
})
