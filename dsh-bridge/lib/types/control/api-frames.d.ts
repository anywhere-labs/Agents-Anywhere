import type { Message } from '@deepseek-ai/dsh-llm';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
/** Web mux payloads emitted by an Agents Anywhere process that owns a Session. */
export type BridgeMuxPayload = {
    type: 'session/event';
    sessionId: SessionId;
    event: SessionEvent;
} | {
    type: 'session/queue';
    sessionId: SessionId;
    items: Array<{
        id: Message['id'];
        placement: 'queued' | 'steering' | 'context';
        message: Message;
    }>;
} | {
    type: 'approval/requested';
    sessionId: SessionId;
    approvalId: string;
    toolName: string;
    callId?: string;
    reason?: string;
} | {
    type: 'approval/resolved';
    sessionId: SessionId;
    approvalId: string;
    outcome: 'allowed-once' | 'rejected' | 'cancelled';
} | {
    type: 'question/requested';
    sessionId: SessionId;
    questions: AskUserQuestionItem[];
} | {
    type: 'question/resolved';
    sessionId: SessionId;
    questionRpcId: string;
    outcome: 'answered' | 'cancelled';
};
/** Correlated Web mux frame preserved across the Session-control transport. */
export interface BridgeMuxEnvelope {
    rpcId: string;
    payload: BridgeMuxPayload;
}
/** Host-stream payloads emitted by an Agents Anywhere owner. */
export type BridgeHostPayload = {
    type: 'host/session-status';
    sessionId: SessionId;
    running: boolean;
} | {
    type: 'host/agent-error';
    sessionId: SessionId;
    message: string;
};
/** Correlated Host frame preserved across Session control. */
export interface BridgeHostEnvelope {
    rpcId: string;
    payload: BridgeHostPayload;
}
/** Full transient owner state sent after a follower subscribes. */
export interface BridgeLiveBaseline {
    mux: BridgeMuxEnvelope[];
    host: BridgeHostEnvelope[];
}
/** Browser response routed back to the Session owner. */
export interface BridgeClientResponse {
    type: 'client-response';
    sessionId: SessionId;
    rpcId: string;
    result: {
        ok: true;
        value: unknown;
    } | {
        ok: false;
        error: {
            code: string;
            message: string;
            details: unknown;
        };
    };
}
/** Carrier acknowledgement for a browser interaction response. */
export type BridgeRpcReceipt = {
    accepted: true;
} | {
    accepted: false;
    reason: 'not-pending' | 'bad-response';
};
/** Assign one push-only mux correlation id. */
export declare function bridgeMuxEnvelope(payload: BridgeMuxPayload): BridgeMuxEnvelope;
/** Assign one push-only Host correlation id. */
export declare function bridgeHostEnvelope(payload: BridgeHostPayload): BridgeHostEnvelope;
