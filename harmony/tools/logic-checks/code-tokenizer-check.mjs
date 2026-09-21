/**
 * The code scanner's output — the spans the code block renderer actually draws.
 *
 * Tokenization is a heuristic, so the point of these assertions is not "is this
 * the ideal classification" but "is this still the classification the shipped
 * scanner makes". A missed keyword, a lost comment, a broken multi-line state or
 * a swallowed string all show up as visibly wrong colours in a tool call's code
 * block, so each case below pins the exact span kinds and offsets.
 *
 * `lib.mjs` mirrors the real `.ets`; `mirror-loader-hooks.mjs` closes the one gap
 * that would otherwise stop this module from loading at all (ArkTS writes its
 * type imports without `import type`, which Node's type stripping then rejects).
 */
import { register } from 'node:module';
register('./mirror-loader-hooks.mjs', import.meta.url);

const { loadModule, suite, expect, finish } = await import('./lib.mjs');

const tok = await loadModule('feature/sessiondetail/CodeTokenizer.ets');
const lang = await loadModule('feature/sessiondetail/CodeLanguage.ets');
suite('feature/sessiondetail/CodeTokenizer.ets');

const K = tok.CodeTokenKind;
const names = new Map(Object.keys(K).map((key) => [K[key], key]));

/** `Keyword("const")`, `Number("42")`, … — the text each span actually covers. */
const spans = (line) => line.spans.map((span) => `${names.get(span.kind)}(${JSON.stringify(line.text.slice(span.start, span.end))})`);
const scan = (text, hint) => tok.tokenizeCode(text, hint === null ? null : lang.codeLanguageFor(hint));
const one = (text, hint) => spans(scan(text, hint).lines[0]);
const eachLine = (text, hint) => scan(text, hint).lines.map(spans);

// ------------------------------------------------------------ language input

expect('an unknown, unhighlighted or null language goes plain',
  [one('const val x = 42 // c', 'not-a-language'), one('const val x = 42 // c', 'markdown'),
    one('const val x = 42', null)],
  [['Plain("const val x = 42 // c")'], ['Plain("const val x = 42 // c")'], ['Plain("const val x = 42")']]);
expect('an empty source still yields one line, and an empty line carries no spans',
  [eachLine('', 'kotlin'), eachLine('a\n\nb', 'kotlin')],
  [[[]], [['Plain("a")'], [], ['Plain("b")']]]);

// ------------------------------------------------------------ layout contract

expect('CRLF and bare CR are normalised so span offsets address the text',
  tok.normalizeCodeText('a\r\nb\rc\nd'), 'a\nb\nc\nd');
expect('normalising is idempotent, and a CRLF source does not shift offsets',
  [tok.normalizeCodeText(tok.normalizeCodeText('a\r\nb')), eachLine('x=1\r\ny=2', 'kotlin')],
  ['a\nb', [['Plain("x")', 'Operator("=")', 'Number("1")'], ['Plain("y")', 'Operator("=")', 'Number("2")']]]);
expect('the line text is carried so gaps can be redrawn, at column 0',
  [scan('let  x', 'kotlin').lines[0].text, scan('   x = 1', 'kotlin').lines[0].spans[0].start],
  ['let  x', 0]);

// -------------------------------------------------------------------- caps

expect('2000 lines is not truncated',
  scan(Array.from({ length: 2000 }, (_, i) => `y${i}`).join('\n'), 'kotlin').truncated, false);
expect('2001 lines is truncated and the tail is dropped',
  (() => {
    const over = scan(Array.from({ length: 2001 }, (_, i) => `x${i}`).join('\n'), 'kotlin');
    return [over.truncated, over.lines.length, over.lines[2000]];
  })(), [true, 2000, undefined]);

// ------------------------------------------------------------------ generic

expect('keywords, identifiers, operators, numbers and comments are separated',
  one('const val x = 42 // c', 'kotlin'),
  ['Keyword("const")', 'Keyword("val")', 'Plain("x")', 'Operator("=")', 'Number("42")', 'Comment("// c")']);
expect('a declaration introducer names the next word, and only that word',
  [one('fun foo(x) {', 'kotlin'), one('class Foo {', 'kotlin')],
  [['Keyword("fun")', 'Function("foo")', 'Punctuation("(")', 'Plain("x")', 'Punctuation(")")', 'Punctuation("{")'],
    ['Keyword("class")', 'Type("Foo")', 'Punctuation("{")']]);
expect('a call is a function with or without whitespace, an uppercase identifier is a type, constants are constants',
  [one('myFn(1)', 'kotlin'), one('myFn (1)', 'kotlin'), one('Foo bar', 'kotlin'), one('true false null', 'kotlin')],
  [['Function("myFn")', 'Punctuation("(")', 'Number("1")', 'Punctuation(")")'],
    ['Function("myFn")', 'Punctuation("(")', 'Number("1")', 'Punctuation(")")'],
    ['Type("Foo")', 'Plain("bar")'],
    ['Constant("true")', 'Constant("false")', 'Constant("null")']]);
expect('numeric literals keep their hex, separator and exponent forms',
  one('0x1F 1_000 1.5e-3 .5 12', 'kotlin'),
  ['Number("0x1F")', 'Number("1_000")', 'Number("1.5e-3")', 'Number(".5")', 'Number("12")']);
expect('an escaped quote does not end the string',
  one('s = "a\\"b" + \'c\'', 'javascript'),
  ['Plain("s")', 'Operator("=")', 'String("\\"a\\\\\\"b\\"")', 'Operator("+")', 'String("\'c\'")']);
expect('a `#` comment needs whitespace before it, so a word keeps its hash',
  [one('x = 1 # tail', 'python'), one('foo#bar', 'python')],
  [['Plain("x")', 'Operator("=")', 'Number("1")', 'Comment("# tail")'], ['Plain("foo#bar")']]);
expect('a block comment carries across lines and closes where it says',
  eachLine('a /* one\ntwo */ b', 'kotlin'),
  [['Plain("a")', 'Comment("/* one")'], ['Comment("two */")', 'Plain("b")']]);
expect('a preprocessor directive is a keyword',
  one('#include <stdio.h>', 'c'),
  ['Keyword("#include")', 'Operator("<")', 'Plain("stdio")', 'Punctuation(".")', 'Plain("h")', 'Operator(">")']);

// ------------------------------------------------------------ stateful forms

expect('a triple quote opens a string that runs on, or swallows the line when it never closes',
  [eachLine('s = """a\nb"""', 'python'), one('s = """a', 'python'), one('"""a""" + b', 'python')],
  [[['Plain("s")', 'Operator("=")', 'String("\\"\\"\\"a")'], ['String("b\\"\\"\\"")']],
    ['Plain("s")', 'Operator("=")', 'String("\\"\\"\\"a")'],
    ['String("\\"\\"\\"a\\"\\"\\"")', 'Operator("+")', 'Plain("b")']]);
expect('shell substitutions are variables, and the form is not language-independent',
  [one('echo $HOME ${NAME} done', 'shellscript'), one('a $x', 'kotlin')],
  [['Keyword("echo")', 'Variable("$HOME")', 'Variable("${NAME}")', 'Keyword("done")'],
    ['Plain("a")', 'Plain("$x")']]);

// ---------------------------------------------------------------------- css

expect('a CSS rule separates selectors, property keys and values',
  one('.cls { color: red; margin: 0 auto; }', 'css'),
  ['Punctuation(".")', 'Selector("cls")', 'Punctuation("{")', 'PropertyKey("color")', 'Punctuation(":")',
    'Plain("red")', 'Punctuation(";")', 'PropertyKey("margin")', 'Punctuation(":")', 'Number("0")',
    'Plain("auto")', 'Punctuation(";")', 'Punctuation("}")']);
expect('a colour literal is one number span, and an at-rule keyword is highlighted once its block opens',
  [one('.a { color: #ff00aa; }', 'css'), one('@media (min-width: 10px) { }', 'css')],
  [['Punctuation(".")', 'Selector("a")', 'Punctuation("{")', 'PropertyKey("color")', 'Punctuation(":")',
    'Number("#ff00aa")', 'Punctuation(";")', 'Punctuation("}")'],
    ['Punctuation("@")', 'Keyword("media")', 'Plain("(")', 'Selector("min-width")', 'Punctuation(":")',
      'Number("10")', 'Selector("px")', 'Plain(")")', 'Punctuation("{")', 'Punctuation("}")']]);

// ------------------------------------------------------------------- markup

expect('tags, attributes, attribute strings and entities are told apart',
  one('<div class="a" data-x=\'y\'>text &amp; more</div>', 'html'),
  ['Punctuation("<")', 'Tag("div")', 'Attribute("class")', 'Operator("=")', 'String("\\"a\\"")',
    'Attribute("data-x")', 'Operator("=")', 'String("\'y\'")', 'Punctuation(">")', 'Plain("text ")',
    'Constant("&amp;")', 'Plain(" more")', 'Punctuation("</")', 'Tag("div")', 'Punctuation(">")']);
expect('a self-closing slash is punctuation, and an entity without its semicolon is not coloured',
  [one('<br/>', 'html'), one('a &amp b', 'html')],
  [['Punctuation("<")', 'Tag("br")', 'Punctuation("/>")'], ['Plain("a &amp b")']]);
expect('a markup comment carries across lines',
  eachLine('<!-- one\ntwo --> x', 'html'),
  [['Comment("<!-- one")'], ['Comment("two -->")', 'Plain(" x")']]);

// --------------------------------------------------------------------- data

expect('a data key is the whole run before its separator, and its value is not a key',
  [one('    "k": 1', 'json'), one('- "k": v', 'yaml'), eachLine('{\n  "key": "v"\n}', 'json')[1]],
  [['PropertyKey("    \\"k\\"")', 'Operator(":")', 'Number("1")'],
    ['PropertyKey("- \\"k\\"")', 'Operator(":")', 'Plain("v")'],
    ['PropertyKey("  \\"key\\"")', 'Operator(":")', 'String("\\"v\\"")']]);

// --------------------------------------------------------------------- bash

expect('bash command lines drop blank and whitespace-only lines and trailing spaces',
  tok.bashCommandLines('ls -la\n\n  git status  \n   \n\tmake build'),
  ['ls -la', '  git status', '\tmake build']);
expect('bash command lines normalise CRLF and keep an empty input empty',
  [tok.bashCommandLines('a\r\nb'), tok.bashCommandLines('')], [['a', 'b'], []]);

finish();
