import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

import { CollabError } from '../domain/collab/errors.js'
import { type CollaborationCheckout, type ReviewChanges, reviewRef } from '../domain/collab/review.js'
import type { RootPolicy } from './roots.js'

const exec = promisify(execFile)

/** Git operations over the selected repository and Connector-owned detached worktrees. */
export class ReviewGit {
  private readonly pending = new Map<string, Promise<string>>()

  public constructor(private readonly dataDir: string, private readonly roots: RootPolicy) {}

  public async base(cwd: string): Promise<string> {
    const root = await this.repository(cwd)
    return this.git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  }

  public async validateCandidate(cwd: string, base: string, candidate: string): Promise<ReviewChanges> {
    await this.verifyCandidate(cwd, base, candidate)
    const summary = await this.git(cwd, ['diff', '--no-ext-diff', '--stat', base, candidate, '--'])
    const patch = await this.git(cwd, ['diff', '--no-ext-diff', '--no-textconv', base, candidate, '--']).catch(() => null)
    return { summary: summary.slice(0, 8_000), patch: patch?.slice(0, 16_000) ?? '', truncated: patch === null || patch.length > 16_000 || summary.length > 8_000 }
  }

  public async verifyCandidate(cwd: string, base: string, candidate: string): Promise<void> {
    try {
      if (candidate === base || await this.git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']) !== candidate) throw new Error()
      await this.git(cwd, ['merge-base', '--is-ancestor', base, candidate])
      if (await this.git(cwd, ['status', '--porcelain', '--untracked-files=normal']) !== '') throw new Error()
    } catch {
      throw new CollabError('invalid_argument', 'The worktree must be clean and checked out at the candidate commit descended from the base.')
    }
  }

  public async prepare(cwd: string, owner: string, input: CollaborationCheckout): Promise<string> {
    const repository = await this.repository(cwd)
    const key = createHash('sha256').update(owner).digest('hex').slice(0, 24)
    const parent = join(this.dataDir, 'review-workspaces', key, input.runId)
    const path = join(parent, `${input.role}-${input.round}`)
    const prior = this.pending.get(path)
    const work = (prior?.catch(() => undefined) ?? Promise.resolve()).then(() => this.checkout(repository, parent, path, input))
    this.pending.set(path, work)
    try {
      return await work
    } finally {
      if (this.pending.get(path) === work) this.pending.delete(path)
    }
  }

  private async checkout(repository: string, parent: string, path: string, input: CollaborationCheckout): Promise<string> {
    await mkdir(parent, { recursive: true, mode: 0o700 })
    if (await stat(path).then(() => true, () => false)) {
      const current = await this.git(path, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => '')
      const shared = await this.git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')
      const expectedShared = await this.git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      if (shared === expectedShared && current === input.commit) return path
      if (shared === expectedShared && input.role === 'implement' && current !== '') {
        await this.git(path, ['merge-base', '--is-ancestor', input.commit, current])
        return path
      }
      throw new CollabError('invalid_argument', 'The saved collaboration worktree does not match the requested checkout.')
    }
    const resolve = () => this.git(repository, ['rev-parse', '--verify', `${input.commit}^{commit}`]).catch(() => '')
    let object = await resolve()
    if (object !== input.commit && input.role === 'review' && input.remote !== undefined) {
      const remotes = (await this.git(repository, ['remote'])).split('\n')
      if (remotes.includes(input.remote)) {
        await this.git(repository, ['fetch', '--no-tags', '--no-recurse-submodules', '--', input.remote, reviewRef(input.runId, input.round)]).catch(() => '')
        object = await resolve()
      }
    }
    if (object !== input.commit) {
      throw new CollabError('review_commit_unavailable', `The selected device does not have commit ${input.commit}. Publish the candidate to ${reviewRef(input.runId, input.round)} on its configured shared remote.`)
    }
    try {
      await this.git(repository, ['worktree', 'add', '--detach', '--', path, input.commit])
    } catch {
      throw new CollabError('invalid_argument', 'The selected project could not create a collaboration worktree.')
    }
    return path
  }

  private async repository(cwd: string): Promise<string> {
    if (!isAbsolute(cwd)) throw new CollabError('invalid_argument', 'An absolute project directory is required.')
    await this.roots.check(cwd)
    const root = await this.git(cwd, ['rev-parse', '--show-toplevel']).catch(() => '')
    if (root === '') throw new CollabError('invalid_argument', 'The selected project is not a Git working tree.')
    await this.roots.check(root)
    return root
  }

  private async git(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'protocol.ext.allow=never', ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  }
}
