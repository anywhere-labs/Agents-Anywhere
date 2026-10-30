import {
  RemoteTimelineItem, TimelineAgentCall, TimelineAgentCallDto, TimelineAttachmentDto,
  TimelineFileChange, TimelineFileChangeDto, TimelineItemContent, TimelineItemSource,
  TimelineReasoningSegmentDto, timelineContent, timelineSource,
} from '../../api/TimelineDtos';
import { arrayField, numberOr, optionalString, stringOr } from '../../api/ApiJson';

/**
 * Timeline projection: wire items to things a screen can draw.
 *
 * Port of `feature/sessiondetail/SessionTimelineProjection.kt`.
 *
 * The wire contract is a `type` plus an optional discriminator inside `content`,
 * and the projection is where that becomes a closed set of render kinds. Two
 * rules are load-bearing:
 *
 *  - an item type the client does not know is kept as a `Diagnostic` rather than
 *    dropped, so a newer Server can add kinds without losing the user's history;
 *  - an assistant message with no text and no attachments is dropped, because
 *    it is a streaming placeholder rather than content.
 */

/** What a row actually is, after projection. */
export enum TimelineMessageKind {
  Text = 0,
  Reasoning = 1,
  Command = 2,
  FileChange = 3,
  AgentCall = 4,
  ToolCall = 5,
  Artifact = 6,
  Marker = 7,
  Error = 8,
  Diagnostic = 9,
  System = 10,
}

/** Who produced the row, which decides its alignment and chrome. */
export enum MessageAuthor {
  User = 0,
  Agent = 1,
  Tool = 2,
}

/** An attachment referenced by a message. */
export interface TimelineAttachment {
  fileId: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface TimelineMessage {
  id: string;
  kind: TimelineMessageKind;
  author: MessageAuthor;
  text: string;
  status: string;
  contentKind: string;
  orderSeq: number;
  revision: number;
  updatedSeq: number;
  createdAt: string;
  role: string | null;
  toolError: boolean;
  /** Secondary line under the summary, e.g. a command string. */
  detail: string;
  /** Pretty-printed raw content, shown when a diagnostic row is expanded. */
  rawContent: string;
  fileChanges: TimelineFileChange[];
  agentCall: TimelineAgentCall | null;
  reasoningSegments: string[];
  attachments: TimelineAttachment[];
  sourceItemId: string | null;
  contentHash: string;
  clientMessageId: string | null;
}

const RECONNECT_PREFIX: string = 'Reconnecting...';

/** Projects a wire item, or null when it must not be rendered at all. */
export function projectTimelineItem(item: RemoteTimelineItem): TimelineMessage | null {
  const content: TimelineItemContent = timelineContent(item);
  const source: TimelineItemSource = timelineSource(item);
  const contentKind: string = stringOr(content.contentKind, '');
  const role: string | null = item.role;
  const attachments: TimelineAttachment[] = parseAttachments(content);
  const hasText: boolean = item.text.trim().length > 0;
  const hasAttachments: boolean = attachments.length > 0;

  const base: TimelineMessage = {
    id: item.id,
    kind: TimelineMessageKind.Diagnostic,
    author: MessageAuthor.Tool,
    text: item.text,
    status: item.status,
    contentKind: contentKind,
    orderSeq: item.orderSeq,
    revision: item.revision,
    updatedSeq: item.updatedSeq,
    createdAt: item.createdAt,
    role: role,
    toolError: content.toolError === true,
    detail: stringOr(content.detail, ''),
    rawContent: '',
    fileChanges: parseFileChanges(content),
    agentCall: parseAgentCall(content),
    reasoningSegments: parseReasoningSegments(content),
    attachments: attachments,
    sourceItemId: optionalString(source.timelineItemId) ?? optionalString(source.itemId),
    contentHash: item.contentHash,
    clientMessageId: optionalString(content.clientMessageId),
  };

  if (item.type === 'message') {
    if (!hasText && !hasAttachments) {
      if (role === 'assistant') {
        // A streaming placeholder: never rendered.
        return null;
      }
      base.kind = TimelineMessageKind.Diagnostic;
      base.author = MessageAuthor.Tool;
      return base;
    }
    base.kind = TimelineMessageKind.Text;
    if (role === 'user') {
      base.author = MessageAuthor.User;
    } else if (role === 'assistant') {
      base.author = MessageAuthor.Agent;
    } else {
      base.author = MessageAuthor.Tool;
    }
    return base;
  }

  if (item.type === 'tool') {
    if (contentKind === 'command') {
      base.kind = TimelineMessageKind.Command;
      base.author = MessageAuthor.Tool;
      base.detail = stringOr(content.command, stringOr(content.detail, ''));
      return base;
    }
    if (contentKind === 'file_change') {
      base.kind = TimelineMessageKind.FileChange;
      base.author = MessageAuthor.Tool;
      return base;
    }
    if (contentKind === 'agent_call') {
      base.kind = TimelineMessageKind.AgentCall;
      base.author = MessageAuthor.Tool;
      return base;
    }
    // web_search, mcp, permission, input_request, tool_call, tool_result, other.
    base.kind = TimelineMessageKind.ToolCall;
    base.author = MessageAuthor.Tool;
    return base;
  }

  if (item.type === 'artifact') {
    if (contentKind === 'file_change') {
      base.kind = TimelineMessageKind.FileChange;
      base.author = MessageAuthor.Tool;
      return base;
    }
    if (contentKind === 'diff') {
      // Diff artifacts duplicate the file-change rows; Android drops them.
      return null;
    }
    base.kind = TimelineMessageKind.Artifact;
    base.author = MessageAuthor.Tool;
    base.detail = stringOr(content.path, base.detail);
    base.rawContent = prettyJson(item.content);
    return base;
  }

  if (item.type === 'marker') {
    base.kind = TimelineMessageKind.Marker;
    base.author = MessageAuthor.Tool;
    return base;
  }

  if (item.type === 'system') {
    if (contentKind === 'reasoning') {
      base.kind = TimelineMessageKind.Reasoning;
      base.author = MessageAuthor.Agent;
      return base;
    }
    if (contentKind === 'compact') {
      base.kind = TimelineMessageKind.Marker;
      base.author = MessageAuthor.Tool;
      return base;
    }
    base.kind = item.status === 'failed' ? TimelineMessageKind.Error : TimelineMessageKind.System;
    base.author = MessageAuthor.Tool;
    return base;
  }

  // Unknown type: keep it visible as a diagnostic instead of losing history.
  base.kind = TimelineMessageKind.Diagnostic;
  base.author = MessageAuthor.Tool;
  base.text = `Unknown timeline item: ${item.type} / ${contentKind}`;
  base.rawContent = prettyJson(item.content);
  return base;
}

export function projectTimeline(items: RemoteTimelineItem[]): TimelineMessage[] {
  const projected: TimelineMessage[] = [];
  for (const item of items) {
    const message: TimelineMessage | null = projectTimelineItem(item);
    if (message !== null) {
      projected.push(message);
    }
  }
  return projected;
}

/** True when the row participates in a run of consecutive tool activity. */
export function isToolRunItem(message: TimelineMessage): boolean {
  if (message.kind === TimelineMessageKind.Reasoning
    || message.kind === TimelineMessageKind.Command
    || message.kind === TimelineMessageKind.FileChange
    || message.kind === TimelineMessageKind.AgentCall
    || message.kind === TimelineMessageKind.ToolCall) {
    return true;
  }
  return message.kind === TimelineMessageKind.Artifact && message.contentKind !== 'diff';
}

/** A reconnect retry row, which groups separately from other tool activity. */
export function isReconnectItem(message: TimelineMessage): boolean {
  return message.kind === TimelineMessageKind.Error && message.text.startsWith(RECONNECT_PREFIX);
}

/** One rendered row: a single item or a collapsed group. */
export interface TimelineRenderItem {
  /** Stable key; group keys are prefixed so they cannot collide with item ids. */
  key: string;
  /** The rows this entry represents, in order. */
  messages: TimelineMessage[];
  kind: TimelineRenderKind;
  /** Only set for `AgentCalls`. */
  parentItemId: string | null;
}

export enum TimelineRenderKind {
  Single = 0,
  ToolRun = 1,
  Reconnect = 2,
  AgentCalls = 3,
}

const MIN_GROUP_SIZE: number = 2;

/**
 * Collapses consecutive tool activity into group rows.
 *
 * Three independent groupings exist, matching Android: tool activity, reconnect
 * retries, and sub-agent calls that share a parent item. A run of one stays a
 * single row so an isolated command is not hidden behind a summary.
 */
export function groupTimeline(
  messages: TimelineMessage[],
  noticeTargetIds: string[],
): TimelineRenderItem[] {
  const items: TimelineRenderItem[] = [];
  let index: number = 0;
  while (index < messages.length) {
    const message: TimelineMessage = messages[index];
    // An item an open notice points at is never collapsed, because the notice
    // card renders inside it.
    const targeted: boolean = message.id !== '' && noticeTargetIds.includes(message.id);

    if (!targeted && isReconnectItem(message)) {
      const run: TimelineMessage[] = collectWhile(
        messages, index, (candidate: TimelineMessage) => isReconnectItem(candidate),
      );
      if (run.length >= MIN_GROUP_SIZE) {
        items.push({
          key: `reconnect:${run[0].id}`,
          messages: run,
          kind: TimelineRenderKind.Reconnect,
          parentItemId: null,
        });
        index += run.length;
        continue;
      }
    }

    if (!targeted && isToolRunItem(message)) {
      const run: TimelineMessage[] = collectWhile(messages, index, isToolRunItem);
      if (run.length >= MIN_GROUP_SIZE) {
        items.push({
          key: `tool-run:${run[0].id}`,
          messages: run,
          kind: TimelineRenderKind.ToolRun,
          parentItemId: null,
        });
        index += run.length;
        continue;
      }
    }

    const parentItemId: string | null = message.agentCall?.parentItemId ?? null;
    if (!targeted && parentItemId !== null) {
      const run: TimelineMessage[] = collectWhile(
        messages,
        index,
        (candidate: TimelineMessage) => candidate.agentCall?.parentItemId === parentItemId,
      );
      if (run.length >= MIN_GROUP_SIZE) {
        items.push({
          key: `agent-calls:${run[0].id}`,
          messages: run,
          kind: TimelineRenderKind.AgentCalls,
          parentItemId: parentItemId,
        });
        index += run.length;
        continue;
      }
    }

    items.push({
      key: `single:${message.id}`,
      messages: [message],
      kind: TimelineRenderKind.Single,
      parentItemId: parentItemId,
    });
    index += 1;
  }
  return items;
}

function collectWhile(
  messages: TimelineMessage[],
  start: number,
  predicate: (message: TimelineMessage) => boolean,
): TimelineMessage[] {
  const run: TimelineMessage[] = [];
  let index: number = start;
  while (index < messages.length && predicate(messages[index])) {
    run.push(messages[index]);
    index += 1;
  }
  return run;
}

// ------------------------------------------------------------------- ordering

/** Timeline order: `orderSeq`, then `updatedSeq`, then id. */
export function compareTimeline(left: TimelineMessage, right: TimelineMessage): number {
  if (left.orderSeq !== right.orderSeq) {
    return left.orderSeq - right.orderSeq;
  }
  if (left.updatedSeq !== right.updatedSeq) {
    return left.updatedSeq - right.updatedSeq;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

/**
 * Merges incoming rows into an existing list.
 *
 * Rows are deduped by id keeping the higher `revision`, and on a tie the one
 * with the higher `updatedSeq`; this is what stops a late event for an older
 * revision from overwriting newer text.
 */
export function mergeTimelineMessages(
  existing: TimelineMessage[],
  incoming: TimelineMessage[],
): TimelineMessage[] {
  const byId: Map<string, TimelineMessage> = new Map();
  for (const message of existing) {
    byId.set(message.id, message);
  }
  for (const message of incoming) {
    const current: TimelineMessage | undefined = byId.get(message.id);
    if (current === undefined
      || message.revision > current.revision
      || (message.revision === current.revision && message.updatedSeq >= current.updatedSeq)) {
      byId.set(message.id, message);
    }
  }
  const merged: TimelineMessage[] = Array.from(byId.values());
  merged.sort(compareTimeline);
  return merged;
}

// ------------------------------------------------------------------- summaries

/** Summary line for a single tool-activity row. */
export function toolActivitySummary(message: TimelineMessage): string {
  const content: string = message.detail;
  if (message.kind === TimelineMessageKind.Command) {
    const command: string = content.length > 0 ? content : 'command';
    return `Ran ${command}`;
  }
  if (message.kind === TimelineMessageKind.FileChange) {
    const single: string | null = singleFilePathBasename(message.fileChanges);
    const allAdds: boolean = message.fileChanges.length > 0
      && message.fileChanges.every((change: TimelineFileChange) => change.action === 'add');
    if (single !== null) {
      return allAdds ? `Created ${single}` : `Changed ${single}`;
    }
    return allAdds ? 'Created files' : 'Changed files';
  }
  if (message.kind === TimelineMessageKind.AgentCall) {
    return agentCallSummary(message.agentCall);
  }
  if (message.kind === TimelineMessageKind.Reasoning) {
    return 'Reasoned';
  }
  if (message.kind === TimelineMessageKind.ToolCall && message.contentKind === 'web_search') {
    const query: string = message.detail.length > 0 ? message.detail : 'web';
    return `Searched ${query}`;
  }
  // Generic tool call: the title line plus its subtitle when both exist.
  const primary: string = message.text.length > 0 ? message.text : '';
  const secondary: string = message.detail;
  if (primary.length > 0 && secondary.length > 0 && primary !== secondary) {
    return `${primary} ${secondary}`;
  }
  if (secondary.length > 0) {
    return secondary;
  }
  if (primary.length > 0) {
    return primary;
  }
  return 'Tool activity';
}

/** Summary for a collapsed tool-activity group. */
export function toolRunSummary(run: TimelineMessage[]): string {
  let reasoned: number = 0;
  let commands: number = 0;
  let changed: number = 0;
  let created: number = 0;
  for (const message of run) {
    if (message.kind === TimelineMessageKind.Reasoning) {
      reasoned += 1;
    } else if (message.kind === TimelineMessageKind.Command) {
      commands += 1;
    } else if (message.kind === TimelineMessageKind.FileChange) {
      const allAdds: boolean = message.fileChanges.length > 0
        && message.fileChanges.every((change: TimelineFileChange) => change.action === 'add');
      if (allAdds) {
        created += 1;
      } else {
        changed += 1;
      }
    }
  }
  const parts: string[] = [];
  if (reasoned > 0) {
    parts.push(`Reasoned ${reasoned} times`);
  }
  if (commands > 0) {
    parts.push(`Ran ${commands} commands`);
  }
  if (changed > 0) {
    parts.push(`Changed ${changed} files`);
  }
  if (created > 0) {
    parts.push(`Created ${created} files`);
  }
  if (parts.length === 0) {
    return `${run.length} activities`;
  }
  return parts.join(', ');
}

export function agentCallSummary(call: TimelineAgentCall | null): string {
  if (call === null) {
    return 'Agent call';
  }
  const description: string = call.description;
  if (description.length > 0) {
    const verb: string = agentCallVerb(call.action);
    return `${verb}: ${description}`;
  }
  return agentCallVerb(call.action);
}

function agentCallVerb(action: string): string {
  if (action === 'invoke') {
    return 'Called agent';
  }
  if (action === 'spawn') {
    return 'Spawned agent';
  }
  if (action === 'send_input') {
    return 'Sent input to agent';
  }
  if (action === 'resume') {
    return 'Resumed agent';
  }
  if (action === 'wait') {
    return 'Waited for agent';
  }
  if (action === 'close') {
    return 'Closed agent';
  }
  return 'Agent call';
}

/** `Reconnecting: <first>–<last>` for a collapsed reconnect group. */
export function reconnectSummary(run: TimelineMessage[]): string {
  const ranges: string[] = [];
  for (const message of run) {
    const match: RegExpMatchArray | null = message.text.match(/(\d+\s*\/\s*\d+)/);
    if (match !== null) {
      ranges.push(match[1].replace(/\s+/g, ''));
    }
  }
  if (ranges.length === 0) {
    return `Reconnecting: ${run.length}`;
  }
  const first: string = ranges[0];
  const last: string = ranges[ranges.length - 1];
  const label: string = first !== last ? `${first}–${last}` : last;
  return `Reconnecting: ${label}`;
}

export function agentCallGroupSummary(run: TimelineMessage[]): string {
  return `Called ${run.length} sub-agents`;
}

// ------------------------------------------------------------------- internals

function parseAttachments(content: TimelineItemContent): TimelineAttachment[] {
  const attachments: TimelineAttachment[] = [];
  for (const entry of arrayField(content.attachments)) {
    // The imported DTO and the local interface have the same shape, but ArkTS
    // rejects structural assignment between them, so the cast goes through
    // `Object` and only the imported type is named.
    const dto: TimelineAttachmentDto = entry as TimelineAttachmentDto;
    const fileId: string = stringOr(dto.fileId, stringOr(dto.id, ''));
    if (fileId.length === 0) {
      continue;
    }
    attachments.push({
      fileId: fileId,
      name: stringOr(dto.name, 'attachment'),
      mediaType: stringOr(dto.mediaType, ''),
      size: numberOr(dto.size, 0),
    });
  }
  return attachments;
}

function parseFileChanges(content: TimelineItemContent): TimelineFileChange[] {
  const changes: TimelineFileChange[] = [];
  for (const entry of arrayField(content.fileChanges)) {
    const dto: TimelineFileChangeDto = entry as TimelineFileChangeDto;
    changes.push({
      action: stringOr(dto.action, ''),
      path: stringOr(dto.path, ''),
      diff: stringOr(dto.diff, ''),
    });
  }
  return changes;
}

function parseAgentCall(content: TimelineItemContent): TimelineAgentCall | null {
  const dto: TimelineAgentCallDto | undefined = content.agentCall;
  if (dto === undefined || dto === null) {
    return null;
  }
  return {
    action: stringOr(dto.action, ''),
    description: stringOr(dto.description, ''),
    parentItemId: optionalString(dto.parentItemId),
  };
}

function parseReasoningSegments(content: TimelineItemContent): string[] {
  const segments: string[] = [];
  for (const entry of arrayField(content.segments)) {
    const dto: TimelineReasoningSegmentDto = entry as TimelineReasoningSegmentDto;
    const text: string = stringOr(dto.text, stringOr(dto.title, ''));
    if (text.length > 0) {
      segments.push(text);
    }
  }
  return segments;
}

/** The basename when every change shares one short path, else null. */
function singleFilePathBasename(changes: TimelineFileChange[]): string | null {
  if (changes.length !== 1) {
    return null;
  }
  const path: string = changes[0].path;
  if (path.length === 0) {
    return null;
  }
  const lastSlash: number = path.lastIndexOf('/');
  const basename: string = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
  if (basename.length === 0 || basename.length > 60) {
    return null;
  }
  return basename;
}

/** Pretty-prints raw content for a diagnostic row, falling back to the original. */
function prettyJson(value: Object): string {
  try {
    const parsed: Object = JSON.parse(JSON.stringify(value)) as Object;
    return JSON.stringify(parsed, null, 2);
  } catch (error) {
    return '';
  }
}

interface TimelineAttachmentWireDto {
  fileId?: string;
  id?: string;
  name?: string;
  mediaType?: string;
  size?: number;
}
