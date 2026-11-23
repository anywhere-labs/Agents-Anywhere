// DSH 0.2.3 inserts the official components' styles after this plugin's own
// style tags. A rule with a single class therefore no longer overrides an
// official component, whose own root rule has the same specificity and now
// comes later (the Modal fell back to its 380px width). Classes passed to an
// official component must be styled through at least two classes, such as
// `.dialog.accountDialog` or `.section .input`, which win in any order.
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const COMPONENTS = '@deepseek-ai/dsh-client-ui-primitives'

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sources(join(dir, entry.name))
    : Promise.resolve(entry.name.endsWith('.tsx') ? [join(dir, entry.name)] : [])))).flat()
}

/** Classes each CSS module passes to official components, as `cssFile -> class -> first use`. */
function componentClasses(base: string, file: string, text: string, found: Map<string, Map<string, string>>): void {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const components = new Set<string>()
  const modules = new Map<string, string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (specifier === COMPONENTS && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) components.add(element.name.text)
    } else if (specifier.endsWith('.module.css')) {
      const local = clause?.name ?? (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name : undefined)
      if (local) modules.set(local.text, resolve(dirname(file), specifier))
    }
  }
  const collect = (node: ts.Node, where: string): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && modules.has(node.expression.text)) {
      const css = modules.get(node.expression.text)!
      const classes = found.get(css) ?? new Map<string, string>()
      if (!classes.has(node.name.text)) classes.set(node.name.text, where)
      found.set(css, classes)
    }
    ts.forEachChild(node, child => collect(child, where))
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && components.has(node.tagName.getText(source))) {
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || !/classname$/iu.test(attribute.name.getText(source)) || !attribute.initializer) continue
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        collect(attribute.initializer, `${relative(base, file)}:${line} <${node.tagName.getText(source)}>`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

/** Top-level selectors of every style rule with their line, comments blanked so offsets stay exact. */
function selectors(css: string): { selector: string, line: number }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, comment => comment.replace(/[^\n]/gu, ' '))
  const result: { selector: string, line: number }[] = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '}' || char === ';') start = index + 1
    if (char !== '{') continue
    const prelude = text.slice(start, index)
    start = index + 1
    if (prelude.trim().startsWith('@')) continue
    let depth = 0, from = 0
    const parts: string[] = []
    for (let at = 0; at < prelude.length; at++) {
      if (prelude[at] === '(') depth++
      else if (prelude[at] === ')') depth--
      else if (prelude[at] === ',' && depth === 0) { parts.push(prelude.slice(from, at)); from = at + 1 }
    }
    parts.push(prelude.slice(from))
    const offset = start - 1 - prelude.length
    for (const part of parts) {
      const line = text.slice(0, offset + prelude.indexOf(part) + part.search(/\S|$/u)).split('\n').length
      result.push({ selector: part.trim(), line })
    }
  }
  return result
}

/**
 * Fail when a class passed to an official component is styled by a rule whose selector is that class alone.
 * @param root - package root URL.
 */
export async function checkComponentStyles(root: URL): Promise<void> {
  const base = fileURLToPath(root)
  const found = new Map<string, Map<string, string>>()
  for (const file of await sources(join(base, 'src/client'))) componentClasses(base, file, await readFile(file, 'utf8'), found)
  const violations: string[] = []
  for (const [css, classes] of found) {
    for (const { selector, line } of selectors(await readFile(css, 'utf8'))) {
      const name = /^\.([\w-]+)$/u.exec(selector)?.[1]
      if (name === undefined || !classes.has(name)) continue
      violations.push(`${relative(base, css)}:${line} \`${selector}\` styles a class passed to ${classes.get(name)!}`)
    }
  }
  if (violations.length) {
    throw new Error(`Single-class rules on official components lose to the components' own styles in DSH 0.2.3, `
      + `which are inserted after the plugin's. Use two classes, for example \`.parent .name\`:\n${violations.join('\n')}`)
  }
}
