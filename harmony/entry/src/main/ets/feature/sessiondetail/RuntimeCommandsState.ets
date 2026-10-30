import { RemoteSessionCommand } from '../../api/RuntimeDtos';

/**
 * Slash commands.
 *
 * Port of the command half of `feature/sessiondetail/SessionRuntimeState.kt`:
 * `RuntimeCommand`, its `matches` filter, and the `RuntimeCommands` load state
 * machine (begin / apply / fail, guarded by a request key so a slow answer for a
 * session the user has left is dropped).
 *
 * The parsing helpers mirror what `SessionDetailScreen.kt` does inline when the
 * composer text starts with `/`: the query is the text after the slash, the
 * command name is the first word, and the arguments are the rest, split on
 * whitespace with the blanks removed.
 */

export class RuntimeCommand {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly aliases: string[];
  readonly category: string | null;
  readonly scope: string;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly acceptsArgs: boolean;
  readonly argsSchema: Object | null;
  readonly metadata: Object;

  constructor(
    id: string,
    title: string,
    description: string | null,
    aliases: string[],
    category: string | null,
    scope: string,
    enabled: boolean,
    disabledReason: string | null,
    acceptsArgs: boolean,
    argsSchema: Object | null,
    metadata: Object,
  ) {
    this.id = id;
    this.title = title;
    this.description = description;
    this.aliases = aliases;
    this.category = category;
    this.scope = scope;
    this.enabled = enabled;
    this.disabledReason = disabledReason;
    this.acceptsArgs = acceptsArgs;
    this.argsSchema = argsSchema;
    this.metadata = metadata;
  }

  /**
   * Android's `RuntimeCommand.matches`.
   *
   * Every whitespace-separated token of the query has to appear somewhere in the
   * haystack, which is the id, the title, the aliases and the description, all
   * lower-cased. An empty query matches everything, and matching is by substring
   * rather than by prefix, so `commit` finds `git.commit`.
   */
  matches(query: string): boolean {
    const tokens: string[] = [];
    for (const token of query.trim().toLowerCase().split(/\s+/)) {
      if (token.length > 0) {
        tokens.push(token);
      }
    }
    if (tokens.length === 0) {
      return true;
    }
    let haystack: string = `${this.id.toLowerCase()} ${this.title.toLowerCase()}`
      + ` ${this.aliases.join(' ').toLowerCase()}`;
    if (this.description !== null) {
      haystack = `${haystack} ${this.description.toLowerCase()}`;
    }
    for (const token of tokens) {
      if (!haystack.includes(token)) {
        return false;
      }
    }
    return true;
  }
}

/** Android's `RemoteSessionCommand.toRuntimeCommand`. */
export function toRuntimeCommand(source: RemoteSessionCommand): RuntimeCommand {
  return new RuntimeCommand(
    source.id,
    source.title,
    source.description,
    source.aliases,
    source.category,
    source.scope,
    source.enabled,
    source.disabledReason,
    source.acceptsArgs,
    source.argsSchema,
    source.metadata,
  );
}

/** The commands the panel offers for a query, capped at Android's six. */
export function matchingCommands(commands: RuntimeCommand[], query: string): RuntimeCommand[] {
  const matches: RuntimeCommand[] = [];
  for (const command of commands) {
    if (command.matches(query)) {
      matches.push(command);
      if (matches.length >= MAX_COMMAND_SUGGESTIONS) {
        break;
      }
    }
  }
  return matches;
}

/** Android's `take(6)`. */
export const MAX_COMMAND_SUGGESTIONS: number = 6;

/** Android's `RuntimeCommands`: the catalog plus its load bookkeeping. */
export class RuntimeCommands {
  readonly commands: RuntimeCommand[];
  readonly isLoading: boolean;
  readonly isLoaded: boolean;
  readonly stale: boolean;
  readonly errorMessage: string | null;
  readonly generation: number;
  /** `<sessionId>:<generation>`, or empty when no request is in flight. */
  readonly requestKey: string;

  constructor(
    commands: RuntimeCommand[],
    isLoading: boolean,
    isLoaded: boolean,
    stale: boolean,
    errorMessage: string | null,
    generation: number,
    requestKey: string,
  ) {
    this.commands = commands;
    this.isLoading = isLoading;
    this.isLoaded = isLoaded;
    this.stale = stale;
    this.errorMessage = errorMessage;
    this.generation = generation;
    this.requestKey = requestKey;
  }

  static empty(): RuntimeCommands {
    return new RuntimeCommands([], false, false, false, null, 0, '');
  }

  /** Starts a load, keeping whatever is already shown until the answer lands. */
  begin(sessionId: string): RuntimeCommands {
    const nextGeneration: number = this.generation + 1;
    return new RuntimeCommands(
      this.commands, true, this.isLoaded, false, null, nextGeneration,
      `${sessionId}:${nextGeneration}`,
    );
  }

  apply(key: string, value: RuntimeCommand[]): RuntimeCommands {
    if (key !== this.requestKey) {
      return this;
    }
    return new RuntimeCommands(value, false, true, false, null, this.generation, this.requestKey);
  }

  fail(key: string, message: string): RuntimeCommands {
    if (key !== this.requestKey) {
      return this;
    }
    return new RuntimeCommands(
      this.commands, false, false, this.commands.length > 0, message, this.generation,
      this.requestKey,
    );
  }
}

/** Android's `commandQuery`: the text after the slash, trimmed. */
export function commandQuery(draft: string): string {
  const trimmed: string = trimStart(draft);
  return (trimmed.startsWith('/') ? trimmed.substring(1) : trimmed).trim();
}

/** Android's `commandName`: the first word of what follows the slash. */
export function commandName(raw: string): string {
  const space: number = raw.indexOf(' ');
  const head: string = space < 0 ? raw : raw.substring(0, space);
  return head.trim();
}

/** Android's `commandArgs`: the rest, split on whitespace, blanks dropped. */
export function commandArgs(raw: string): string[] {
  const space: number = raw.indexOf(' ');
  const rest: string = space < 0 ? '' : raw.substring(space + 1).trim();
  const args: string[] = [];
  for (const token of rest.split(/\s+/)) {
    if (token.length > 0) {
      args.push(token);
    }
  }
  return args;
}

/**
 * The command a typed name refers to, by id or by alias, case-insensitively.
 */
export function findCommand(commands: RuntimeCommand[], name: string): RuntimeCommand | null {
  if (name.length === 0) {
    return null;
  }
  const wanted: string = name.toLowerCase();
  for (const command of commands) {
    if (command.id.toLowerCase() === wanted) {
      return command;
    }
    for (const alias of command.aliases) {
      if (alias.toLowerCase() === wanted) {
        return command;
      }
    }
  }
  return null;
}

/** `String.trimStart` without relying on the engine's Unicode whitespace set. */
function trimStart(value: string): string {
  let start: number = 0;
  while (start < value.length && isWhitespace(value.charAt(start))) {
    start += 1;
  }
  return start === 0 ? value : value.substring(start);
}

function isWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n'
    || character === '\r' || character === '\f' || character === '\v';
}
