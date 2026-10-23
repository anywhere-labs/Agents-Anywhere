/*
 * Timeline tool-row summarization helpers (round 21 redesign).
 *
 * Mirrors web-next session-tool-cards.tsx / timeline-summary.ts: tool-like
 * timeline items are condensed into weak single-line rows with humanized
 * titles, and runs of consecutive tool-like items collapse into groups.
 * All functions are pure; localized strings are supplied by the caller so
 * this module stays free of resource lookups.
 */

import { RemoteTimelineFileChange, RemoteTimelineItem } from 'network';

// View model for one weak tool row (single or inside a group).
export interface TimelineToolRowModel {
  rowKey: string;
  itemId: string;
  kind: string;
  title: string;
  running: boolean;
  failed: boolean;
  hasDetail: boolean;
  text: string;
  command: string;
  output: string;
  changes: RemoteTimelineFileChange[];
}

// View model for a collapsed run of consecutive tool-like rows.
export interface TimelineToolGroupModel {
  groupKey: string;
  summary: string;
  running: boolean;
  members: TimelineToolRowModel[];
}

// Localized templates resolved once per rebuild by the page. Templates carry
// %1$s / %1$d placeholders that callers replace manually (getStringSync does
// not substitute $r format arguments).
export interface TimelineToolStrings {
  ran: string;
  commandFallback: string;
  createdFile: string;
  changedFile: string;
  createdFiles: string;
  changedFiles: string;
  searched: string;
  webFallback: string;
  reasoning: string;
  groupReasoning: string;
  groupTools: string;
  groupItems: string;
}

const INLINE_FILE_CHANGE_PATH_MAX_CHARS = 60;

// Matches web isToolRunBarItem: system reasoning, tool items and non-diff
// artifacts participate in weak rows / grouping.
export function isTimelineToolRunItem(item: RemoteTimelineItem): boolean {
  if (item.type === 'system') {
    return item.kind === 'reasoning';
  }
  if (item.type === 'tool') {
    return true;
  }
  if (item.type === 'artifact') {
    return item.kind !== 'diff';
  }
  return false;
}

export function timelineKindOf(item: RemoteTimelineItem): string {
  if (item.type === 'system' && item.kind === 'reasoning') {
    return 'reasoning';
  }
  if (item.type === 'artifact') {
    return item.kind !== null && item.kind.length > 0 ? item.kind : 'artifact';
  }
  if (item.kind !== null && item.kind.length > 0) {
    return item.kind;
  }
  return 'tool';
}

export function timelineStatusRunning(status: string): boolean {
  return status === 'running' || status === 'pending' || status === 'waiting' ||
    status === 'waiting_approval' || status === 'in_progress';
}

export function timelineStatusFailed(status: string): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'interrupted' ||
    status === 'error';
}

// Mirrors web ToolCard.hasDetail: reasoning rows expand to their full text,
// other rows expand when they carry command / output / file changes.
export function timelineHasDetail(item: RemoteTimelineItem, kind: string): boolean {
  if (kind === 'reasoning') {
    return item.text.length > 0;
  }
  if (item.command !== null && item.command.length > 0) {
    return true;
  }
  if (item.output !== null && item.output.length > 0) {
    return true;
  }
  return item.changes.length > 0;
}

export function normalizeDisplayPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

// Mirrors web displayPathForSession: strips the session cwd prefix so paths
// read relative to the workspace.
export function displayPathFor(path: string, cwd: string | null): string {
  if (path.length === 0) {
    return path;
  }
  if (cwd === null || cwd.length === 0) {
    return path;
  }
  const normalizedPath = normalizeDisplayPath(path);
  const normalizedCwd = normalizeDisplayPath(cwd);
  if (normalizedPath === normalizedCwd) {
    return '.';
  }
  const cwdPrefix = normalizedCwd.endsWith('/') ? normalizedCwd : `${normalizedCwd}/`;
  if (!normalizedPath.startsWith(cwdPrefix)) {
    return path;
  }
  const stripped = normalizedPath.substring(cwdPrefix.length);
  return stripped.length > 0 ? stripped : '.';
}

// Normalizes a change action string onto created/deleted/renamed/modified,
// falling back to 'changed' (mirrors web fileChangeAction).
export function fileChangeActionOf(change: RemoteTimelineFileChange): string {
  const value = change.action.toLowerCase();
  if (value === 'add' || value === 'added' || value === 'create' || value === 'created') {
    return 'created';
  }
  if (value === 'delete' || value === 'deleted' || value === 'remove' || value === 'removed') {
    return 'deleted';
  }
  if (value === 'rename' || value === 'renamed' || value === 'move' || value === 'moved') {
    return 'renamed';
  }
  if (value === 'modify' || value === 'modified' || value === 'change' || value === 'changed' ||
    value === 'edit' || value === 'edited' || value === 'update' || value === 'updated') {
    return 'modified';
  }
  return 'changed';
}

// Humanized one-line title for a tool-like item (mirrors web timelineToolTitle
// for the kinds the HarmonyOS client renders).
export function timelineToolRowTitle(item: RemoteTimelineItem, kind: string, cwd: string | null,
  strings: TimelineToolStrings): string {
  if (kind === 'reasoning') {
    return strings.reasoning;
  }
  const changes = item.changes;
  if (kind === 'file_change') {
    let allCreated = true;
    for (const change of changes) {
      if (fileChangeActionOf(change) !== 'created') {
        allCreated = false;
        break;
      }
    }
    if (changes.length === 1) {
      const singlePath = displayPathFor(changes[0].path, cwd);
      if (singlePath.length <= INLINE_FILE_CHANGE_PATH_MAX_CHARS) {
        return (allCreated ? strings.createdFile : strings.changedFile).replace('%1$s', singlePath);
      }
    }
    return allCreated ? strings.createdFiles : strings.changedFiles;
  }
  if (kind === 'command') {
    const command = item.command === null ? '' : item.command;
    return strings.ran.replace('%1$s', command.length > 0 ? command : strings.commandFallback);
  }
  if (kind === 'web_search') {
    const query = item.query === null ? '' : item.query;
    return strings.searched.replace('%1$s', query.length > 0 ? query : strings.webFallback);
  }
  if (item.type === 'artifact') {
    const path = item.targetPath === null ? '' : item.targetPath;
    return path.length > 0 ? path : kind;
  }
  const toolName = item.toolName === null ? '' : item.toolName;
  const targetPath = item.targetPath === null ? '' : item.targetPath;
  const query = item.query === null ? '' : item.query;
  const target = targetPath.length > 0 ? displayPathFor(targetPath, cwd) : query;
  if (toolName.length > 0) {
    return target.length > 0 ? `${toolName} ${target}` : toolName;
  }
  if (target.length > 0) {
    return target;
  }
  return kind;
}

export function timelineToolRowModelOf(item: RemoteTimelineItem, cwd: string | null,
  strings: TimelineToolStrings): TimelineToolRowModel {
  const kind = timelineKindOf(item);
  const changes = item.changes;
  // Mirrors web ToolCard: when file changes exist the output is folded into
  // the change rows and not shown as a separate panel.
  const output = changes.length > 0 ? '' : (item.output ?? '');
  const model: TimelineToolRowModel = {
    rowKey: `${item.id}_${item.revision}_${item.updatedSeq}`,
    itemId: item.id,
    kind: kind,
    title: timelineToolRowTitle(item, kind, cwd, strings),
    running: timelineStatusRunning(item.status),
    failed: timelineStatusFailed(item.status),
    hasDetail: timelineHasDetail(item, kind),
    text: item.text,
    command: item.command ?? '',
    output: output,
    changes: changes
  };
  return model;
}

// Group summary mirrors web toolRunSummary: reasoning + tool counts joined
// with ", ", falling back to a plain activity count.
export function timelineToolGroupModelOf(members: TimelineToolRowModel[],
  strings: TimelineToolStrings): TimelineToolGroupModel {
  let reasoningCount = 0;
  let toolCount = 0;
  let running = false;
  for (const member of members) {
    if (member.kind === 'reasoning') {
      reasoningCount++;
    } else {
      toolCount++;
    }
    if (member.running) {
      running = true;
    }
  }
  const parts: string[] = [];
  if (reasoningCount > 0) {
    parts.push(strings.groupReasoning.replace('%1$d', `${reasoningCount}`));
  }
  if (toolCount > 0) {
    parts.push(strings.groupTools.replace('%1$d', `${toolCount}`));
  }
  const summary = parts.length > 0 ? parts.join(', ') :
    strings.groupItems.replace('%1$d', `${members.length}`);
  const group: TimelineToolGroupModel = {
    groupKey: `group_${members.length > 0 ? members[0].itemId : 'unknown'}_${members.length}`,
    summary: summary,
    running: running,
    members: members
  };
  return group;
}

export function emptyTimelineToolRowModel(): TimelineToolRowModel {
  const model: TimelineToolRowModel = {
    rowKey: '',
    itemId: '',
    kind: 'tool',
    title: '',
    running: false,
    failed: false,
    hasDetail: false,
    text: '',
    command: '',
    output: '',
    changes: []
  };
  return model;
}

export function emptyTimelineToolGroupModel(): TimelineToolGroupModel {
  const group: TimelineToolGroupModel = {
    groupKey: '',
    summary: '',
    running: false,
    members: []
  };
  return group;
}

// Kind glyph for the weak row icon. Symbols verified against
// id_defined.json (see round 21 notes).
export function timelineKindSymbol(kind: string): Resource {
  if (kind === 'command') {
    return $r('sys.symbol.keyboard');
  }
  if (kind === 'file_change' || kind === 'artifact') {
    return $r('sys.symbol.doc_text');
  }
  if (kind === 'web_search') {
    return $r('sys.symbol.magnifyingglass');
  }
  if (kind === 'reasoning') {
    return $r('sys.symbol.lightbulb');
  }
  return $r('sys.symbol.gearshape');
}
