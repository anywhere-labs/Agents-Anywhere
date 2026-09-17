import {
  MessageAuthor, TimelineMessage, TimelineMessageKind, TimelineRenderItem,
} from './SessionTimelineProjection';

/**
 * Turn-end reply actions.
 *
 * Port of `buildAgentActionsByTurnEnd` and `AgentReplyAction` in
 * `ui/screens/sessiondetail/SessionMessages.kt`.
 *
 * Android shows a divider with a copy and a share button under the *last* row of
 * every completed turn. A turn starts at a row containing a user text message and
 * runs to the row before the next one; the copy text is the turn's agent messages
 * joined with a blank line between them, and the item ids are the ids of exactly
 * those messages, which is what a share of "this reply" covers.
 *
 * Two details are deliberate:
 *
 *  - a page that starts in the middle of a turn (older history was paged in) has
 *    no user row, so the first copyable agent text opens a turn instead;
 *  - the newest turn only offers the action once it stopped streaming, which is
 *    why the caller passes `latestTurnInProgress`.
 */

/** The action a completed turn offers at its last row. */
export class AgentReplyAction {
  readonly copyText: string;
  readonly itemIds: string[];

  constructor(copyText: string, itemIds: string[]) {
    this.copyText = copyText;
    this.itemIds = itemIds;
  }
}

/** Row key to the action shown beneath that row. */
export function buildAgentReplyActions(
  items: TimelineRenderItem[],
  latestTurnInProgress: boolean,
): Map<string, AgentReplyAction> {
  const actions: Map<string, AgentReplyAction> = new Map<string, AgentReplyAction>();
  let replyParts: string[] = [];
  let replyItemIds: Set<string> = new Set<string>();
  let turnEndKey: string = '';
  let hasOpenTurn: boolean = false;

  const finishTurn = (includeCopyAction: boolean): void => {
    const parts: string[] = [];
    for (const part of replyParts) {
      if (part.trim().length > 0) {
        parts.push(part);
      }
    }
    if (includeCopyAction && replyItemIds.size > 0 && turnEndKey.length > 0) {
      actions.set(turnEndKey, new AgentReplyAction(parts.join('\n\n').trim(), Array.from(replyItemIds)));
    }
    replyParts = [];
    replyItemIds = new Set<string>();
    turnEndKey = '';
    hasOpenTurn = false;
  };

  for (const item of items) {
    let startsTurn: boolean = false;
    for (const message of item.messages) {
      if (message.kind === TimelineMessageKind.Text && message.author === MessageAuthor.User) {
        startsTurn = true;
        break;
      }
    }
    if (startsTurn && hasOpenTurn) {
      finishTurn(true);
    }
    if (startsTurn) {
      hasOpenTurn = true;
    }

    const copyableParts: string[] = [];
    for (const message of item.messages) {
      const text: string = agentCopyText(message);
      if (text.trim().length > 0) {
        copyableParts.push(text);
      }
    }
    if (copyableParts.length > 0 && !hasOpenTurn) {
      // The page can begin in the middle of a turn, before its user row.
      hasOpenTurn = true;
    }
    if (hasOpenTurn) {
      turnEndKey = item.key;
      for (const part of copyableParts) {
        replyParts.push(part);
      }
      for (const message of item.messages) {
        const id: string | null = message.sourceItemId;
        if (isCopyableAgentText(message) && id !== null && id.length > 0) {
          replyItemIds.add(id);
        }
      }
    }
  }
  if (hasOpenTurn) {
    // A turn still streaming has nothing to copy yet.
    finishTurn(!latestTurnInProgress);
  }
  return actions;
}

function isCopyableAgentText(message: TimelineMessage): boolean {
  return message.kind === TimelineMessageKind.Text && message.author === MessageAuthor.Agent;
}

/** Android's `agentCopyText`: agent prose, without its trailing line breaks. */
function agentCopyText(message: TimelineMessage): string {
  if (!isCopyableAgentText(message)) {
    return '';
  }
  const text: string = message.text;
  let end: number = text.length;
  while (end > 0 && (text.charAt(end - 1) === '\r' || text.charAt(end - 1) === '\n')) {
    end -= 1;
  }
  return end === text.length ? text : text.substring(0, end);
}
