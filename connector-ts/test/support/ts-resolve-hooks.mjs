import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(specifier: string, context: { parentURL?: string }) => Promise<unknown>} next
 */
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('.') || specifier.startsWith('file:')) && specifier.endsWith('.js') && context.parentURL !== undefined) {
    const candidate = new URL(specifier.replace(/\.js$/u, '.ts'), context.parentURL)
    const original = new URL(specifier, context.parentURL)
    if (!existsSync(fileURLToPath(original)) && existsSync(fileURLToPath(candidate))) return next(candidate.href, context)
  }
  return next(specifier, context)
}
