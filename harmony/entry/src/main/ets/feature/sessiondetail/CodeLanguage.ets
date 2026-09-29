/**
 * Code language table.
 *
 * Port of the language detection half of
 * `ui/screens/sessiondetail/CodeBlockPreview.kt` (`SoraTextMate.specFor`,
 * `specsByName`, `specsByExtension`, `languageAliases`).
 *
 * Android tokenizes with real TextMate grammars loaded from assets; HarmonyOS has
 * no equivalent engine and the project prefers zero third-party dependencies, so
 * the grammar is replaced by the lightweight scanner in `CodeTokenizer`. What is
 * kept identical is the *mapping*: the same aliases, the same extension table and
 * the same special cases, so the same fence label selects the same language and
 * an unrecognized label still falls back to plain text.
 */

/** How the scanner reads a language. */
export enum CodeLexerStyle {
  /** No highlighting at all, matching Android's `EmptyLanguage` fallback. */
  Plain = 0,
  /** `//` and block comments, quoted strings, brace-delimited blocks. */
  CLike = 1,
  /** `#` comments and quoted strings; Python and Ruby. */
  Hash = 2,
  /** `#` comments, `$var` substitutions; Shell and Dockerfile. */
  Shell = 3,
  /** `<tag attr="value">` markup; HTML and XML. */
  Markup = 4,
  /** Selector / property / value states; CSS, SCSS and Sass. */
  Css = 5,
  /** `key: value` or `key = value` lines; JSON, YAML, TOML, INI and dotenv. */
  Data = 6,
  /** `--` comments, `'` strings and uppercase-insensitive keywords; SQL. */
  Sql = 7,
}

/** One language the scanner knows how to read. */
export interface CodeLanguageSpec {
  name: string;
  style: CodeLexerStyle;
  /** Lowercase keywords; compared case-insensitively only when `caseInsensitive`. */
  keywords: Set<string>;
  /** `true`, `null`, `self`, … drawn in the language-constant tone. */
  constants: Set<string>;
  /** Line-comment markers, tried in order. */
  lineComments: string[];
  blockComments: boolean;
  /** Characters that open a string. */
  quotes: string;
  /** Python's `'''` and `"""`. */
  tripleQuotes: boolean;
  /** Characters that introduce a variable, such as `$` in shell. */
  variablePrefixes: string;
  /** Identifiers that name a function definition, so they draw as functions. */
  functionIntroducers: Set<string>;
  /** Identifiers that name a type definition, so they draw as types. */
  typeIntroducers: Set<string>;
  /** Data styles read `key: value` pairs at the start of a line. */
  detectKeys: boolean;
  /** Separators that end a data key. */
  keySeparators: string;
  caseInsensitive: boolean;
}

/** Builds a lowercase set from a space-separated list. */
function words(value: string): Set<string> {
  const set: Set<string> = new Set<string>();
  for (const word of value.split(' ')) {
    if (word.length > 0) {
      set.add(word);
    }
  }
  return set;
}

const NO_WORDS: Set<string> = new Set<string>();

const JS_KEYWORDS: Set<string> = words(
  'const let var function return if else for while do switch case default break continue new '
  + 'class extends super import export from as in of typeof instanceof delete void static get set '
  + 'async await yield try catch finally throw interface type enum implements declare namespace '
  + 'abstract public private protected readonly override satisfies keyof infer asserts is',
);
const JVM_KEYWORDS: Set<string> = words(
  'package import class interface enum extends implements public private protected static final '
  + 'abstract synchronized volatile transient native strictfp new return if else for while do '
  + 'switch case default break continue try catch finally throw throws instanceof this record '
  + 'fun val var object when is as in by lateinit override open data sealed companion suspend '
  + 'internal inline reified crossinline noinline operator infix const out vararg lazy init '
  + 'actual expect annotation',
);
const C_KEYWORDS: Set<string> = words(
  'auto break case char const continue default do double else enum extern float for goto if inline '
  + 'int long register return short signed sizeof static struct switch typedef union unsigned void '
  + 'volatile while class namespace template public private protected new delete this using virtual '
  + 'override constexpr noexcept nullptr bool true false friend explicit operator typename concept',
);
const CSHARP_KEYWORDS: Set<string> = words(
  'namespace using class struct interface enum public private protected internal static void int '
  + 'string bool var new return if else for foreach while do switch case default break continue try '
  + 'catch finally throw this base null override virtual abstract sealed readonly const async await '
  + 'delegate event get set partial record where is as out ref params',
);
const SWIFT_KEYWORDS: Set<string> = words(
  'let var func class struct enum protocol extension import if else for while switch case default '
  + 'break continue return guard defer throw throws try catch as is in nil self super init deinit '
  + 'public private internal fileprivate open static final override mutating lazy weak unowned '
  + 'where some any actor async await',
);
const DART_KEYWORDS: Set<string> = words(
  'void var final const class extends implements import library if else for while switch case '
  + 'default break continue return new this super null true false async await yield static abstract '
  + 'enum mixin with factory get set late required covariant',
);
const GO_KEYWORDS: Set<string> = words(
  'break case chan const continue default defer else fallthrough for func go goto if import '
  + 'interface map package range return select struct switch type var nil true false make new len '
  + 'cap append copy delete close panic recover go',
);
const RUST_KEYWORDS: Set<string> = words(
  'as break const continue crate else enum extern false fn for if impl in let loop match mod move '
  + 'mut pub ref return self static struct super trait true type unsafe use where while async await '
  + 'dyn box macro_rules',
);
const RUBY_KEYWORDS: Set<string> = words(
  'def end if elsif else unless while until for do then begin rescue ensure raise return class '
  + 'module yield require include extend attr_accessor attr_reader attr_writer lambda proc nil '
  + 'true false self super and or not puts',
);
const PHP_KEYWORDS: Set<string> = words(
  'function class extends implements interface public private protected static return if else '
  + 'elseif foreach while for switch case default break continue new echo print try catch finally '
  + 'throw namespace use as array null true false isset unset global const abstract final trait '
  + 'instanceof require require_once include include_once',
);
const PYTHON_KEYWORDS: Set<string> = words(
  'and as assert async await break class continue def del elif else except finally for from global '
  + 'if import in is lambda nonlocal not or pass raise return try while with yield match case',
);
const SHELL_KEYWORDS: Set<string> = words(
  'if then else elif fi for while until do done case esac function return in local export readonly '
  + 'declare source alias echo cd set unset trap exit eval exec shift printf test',
);
const SQL_KEYWORDS: Set<string> = words(
  'select from where insert into update delete join inner left right full outer cross group by '
  + 'order having limit offset values set create table alter drop index view as and or not null is '
  + 'like between distinct union all exists case when then else end primary key foreign references '
  + 'default unique constraint begin commit rollback with returning',
);
const LUA_KEYWORDS: Set<string> = words(
  'and break do else elseif end false for function if in local nil not or repeat return then true '
  + 'until while require',
);
const R_KEYWORDS: Set<string> = words(
  'function if else for while repeat break next return true false null na inf nan library require '
  + 'in',
);

const COMMON_CONSTANTS: Set<string> = words(
  'true false null nil none undefined nan inf self this super',
);

const FUNCTION_INTRODUCERS: Set<string> = words(
  'def function func fn fun sub method',
);
const TYPE_INTRODUCERS: Set<string> = words(
  'class struct interface enum type impl trait extends implements record module namespace protocol',
);

/** Style-specific defaults, so each language row stays a single line. */
function spec(
  name: string,
  style: CodeLexerStyle,
  keywords: Set<string>,
): CodeLanguageSpec {
  const hash: boolean = style === CodeLexerStyle.Hash;
  const shell: boolean = style === CodeLexerStyle.Shell;
  const data: boolean = style === CodeLexerStyle.Data;
  const sql: boolean = style === CodeLexerStyle.Sql;
  const markup: boolean = style === CodeLexerStyle.Markup;
  const css: boolean = style === CodeLexerStyle.Css;
  return {
    name: name,
    style: style,
    keywords: keywords,
    constants: COMMON_CONSTANTS,
    lineComments: hash || shell || data ? ['#'] : (sql ? ['--'] : ['//']),
    blockComments: style === CodeLexerStyle.CLike || sql || css || markup,
    quotes: sql ? '\'"' : (markup ? '\'"' : (css ? '\'"' : '"\'`')),
    tripleQuotes: hash && name === 'python',
    variablePrefixes: shell ? '$' : '',
    functionIntroducers: FUNCTION_INTRODUCERS,
    typeIntroducers: TYPE_INTRODUCERS,
    detectKeys: data,
    keySeparators: name === 'json' || name === 'yaml' ? ':' : ':=',
    caseInsensitive: sql,
  };
}

const SPECS: Map<string, CodeLanguageSpec> = new Map<string, CodeLanguageSpec>();

function register(spec: CodeLanguageSpec): void {
  SPECS.set(spec.name, spec);
}

register(spec('kotlin', CodeLexerStyle.CLike, JVM_KEYWORDS));
register(spec('java', CodeLexerStyle.CLike, JVM_KEYWORDS));
register(spec('groovy', CodeLexerStyle.CLike, JVM_KEYWORDS));
register(spec('javascript', CodeLexerStyle.CLike, JS_KEYWORDS));
register(spec('typescript', CodeLexerStyle.CLike, JS_KEYWORDS));
register(spec('jsx', CodeLexerStyle.CLike, JS_KEYWORDS));
register(spec('tsx', CodeLexerStyle.CLike, JS_KEYWORDS));
register(spec('c', CodeLexerStyle.CLike, C_KEYWORDS));
register(spec('cpp', CodeLexerStyle.CLike, C_KEYWORDS));
register(spec('csharp', CodeLexerStyle.CLike, CSHARP_KEYWORDS));
register(spec('swift', CodeLexerStyle.CLike, SWIFT_KEYWORDS));
register(spec('dart', CodeLexerStyle.CLike, DART_KEYWORDS));
register(spec('go', CodeLexerStyle.CLike, GO_KEYWORDS));
register(spec('rust', CodeLexerStyle.CLike, RUST_KEYWORDS));
register(spec('php', CodeLexerStyle.CLike, PHP_KEYWORDS));
register(spec('lua', CodeLexerStyle.CLike, LUA_KEYWORDS));
register(spec('ruby', CodeLexerStyle.Hash, RUBY_KEYWORDS));
register(spec('python', CodeLexerStyle.Hash, PYTHON_KEYWORDS));
register(spec('r', CodeLexerStyle.Hash, R_KEYWORDS));
register(spec('shellscript', CodeLexerStyle.Shell, SHELL_KEYWORDS));
register(spec('docker', CodeLexerStyle.Shell, SHELL_KEYWORDS));
register(spec('sql', CodeLexerStyle.Sql, SQL_KEYWORDS));
register(spec('html', CodeLexerStyle.Markup, NO_WORDS));
register(spec('xml', CodeLexerStyle.Markup, NO_WORDS));
register(spec('css', CodeLexerStyle.Css, words('important media supports import charset keyframes')));
register(spec('scss', CodeLexerStyle.Css, words('important media supports import use mixin include extend')));
register(spec('sass', CodeLexerStyle.Css, words('important media supports import use mixin include extend')));
register(spec('json', CodeLexerStyle.Data, NO_WORDS));
register(spec('yaml', CodeLexerStyle.Data, NO_WORDS));
register(spec('toml', CodeLexerStyle.Data, NO_WORDS));
register(spec('ini', CodeLexerStyle.Data, NO_WORDS));
register(spec('dotenv', CodeLexerStyle.Data, NO_WORDS));
// Markdown has a TextMate grammar on Android; the scanner leaves it plain rather
// than colouring it wrongly. It is still registered so the label resolves.
register(spec('markdown', CodeLexerStyle.Plain, NO_WORDS));

/** Fence labels that Android renders as one bash command card per line. */
export function isBashLanguage(language: string): boolean {
  const lower: string = language.trim().toLowerCase();
  return lower === 'bash' || lower === 'sh' || lower === 'shell' || lower === 'zsh';
}

const ALIASES: Map<string, string> = new Map<string, string>([
  ['bash', 'shellscript'],
  ['c++', 'cpp'],
  ['js', 'javascript'],
  ['md', 'markdown'],
  ['py', 'python'],
  ['sh', 'shellscript'],
  ['shell', 'shellscript'],
  ['ts', 'typescript'],
  ['zsh', 'shellscript'],
]);

const EXTENSIONS: Map<string, string> = new Map<string, string>([
  ['kt', 'kotlin'], ['kts', 'kotlin'], ['java', 'java'], ['js', 'javascript'],
  ['mjs', 'javascript'], ['cjs', 'javascript'], ['ts', 'typescript'], ['mts', 'typescript'],
  ['cts', 'typescript'], ['jsx', 'jsx'], ['tsx', 'tsx'], ['json', 'json'],
  ['yaml', 'yaml'], ['yml', 'yaml'], ['sh', 'shellscript'], ['bash', 'shellscript'],
  ['zsh', 'shellscript'], ['css', 'css'], ['scss', 'scss'], ['sass', 'sass'],
  ['sql', 'sql'], ['toml', 'toml'], ['properties', 'ini'], ['env', 'dotenv'],
  ['go', 'go'], ['rs', 'rust'], ['c', 'c'], ['h', 'c'], ['cpp', 'cpp'], ['cc', 'cpp'],
  ['cxx', 'cpp'], ['hpp', 'cpp'], ['hh', 'cpp'], ['cs', 'csharp'], ['swift', 'swift'],
  ['dart', 'dart'], ['rb', 'ruby'], ['php', 'php'], ['r', 'r'], ['html', 'html'],
  ['htm', 'html'], ['xml', 'xml'], ['md', 'markdown'], ['markdown', 'markdown'],
  ['lua', 'lua'], ['py', 'python'],
]);

/**
 * Resolves a fence label or file name to a language.
 *
 * The order of the special cases is copied from Android: Dockerfile names, Gradle
 * script suffixes, dotenv files and the three WeChat mini-program extensions are
 * checked before the alias and extension tables.
 */
export function codeLanguageFor(hint: string): CodeLanguageSpec | null {
  let name: string = hint;
  const slash: number = name.lastIndexOf('/');
  if (slash >= 0) {
    name = name.substring(slash + 1);
  }
  const backslash: number = name.lastIndexOf('\\');
  if (backslash >= 0) {
    name = name.substring(backslash + 1);
  }
  const lower: string = name.toLowerCase();

  let key: string = '';
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) {
    key = 'docker';
  } else if (lower.endsWith('.gradle.kts')) {
    key = 'kotlin';
  } else if (lower.endsWith('.gradle')) {
    key = 'groovy';
  } else if (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')) {
    key = 'dotenv';
  } else if (lower.endsWith('.wxml')) {
    key = 'html';
  } else if (lower.endsWith('.wxss')) {
    key = 'css';
  } else if (lower.endsWith('.wxs')) {
    key = 'javascript';
  } else {
    const alias: string | undefined = ALIASES.get(lower);
    const direct: string = alias === undefined ? lower : alias;
    if (SPECS.has(direct)) {
      key = direct;
    } else {
      const dot: number = lower.lastIndexOf('.');
      const extension: string = dot >= 0 ? lower.substring(dot + 1) : '';
      const mapped: string | undefined = EXTENSIONS.get(extension);
      key = mapped === undefined ? '' : mapped;
    }
  }

  const spec0: CodeLanguageSpec | undefined = key.length === 0 ? undefined : SPECS.get(key);
  return spec0 === undefined ? null : spec0;
}
