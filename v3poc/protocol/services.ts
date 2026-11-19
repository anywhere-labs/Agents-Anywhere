// aa.v3 services (PoC draft): the RPC surface clients call, modelled on Effi Cloud's MeshCall services
// (`cloud.v1.Conversations`, `cloud.v1.Terminals`, `cloud.v1.Instance`). Not implemented in the PoC: the demos replay
// fixtures in place of `watch`. Listed here so the data model is read together with the calls that produce it.
//
// Transport (proposal): MeshCall. The Connector registers these as targeted services (instance = device id); clients
// reach them through the Router with a tunnel credential the Server issues, as the Effi Cloud console does with
// `POST /api/instances/{id}/tunnel`. Bytes are base64 strings.

import type { Control, Message, Session, SessionSummary, WatchEvent } from './timeline'

type Stream<T> = AsyncIterable<T>

export interface SessionsService /* aa.v3.Sessions */ {
  list(): Promise<{ sessions: SessionSummary[]; projects: string[] }>
  /** Snapshot, then the whole list on every change (coalesced 500 ms, slow watchers get the newest). */
  watch_list(): Stream<{ type: 'snapshot' | 'update'; sessions: SessionSummary[]; projects: string[] }>
  create(req: { agent: string; title?: string; cwd?: string; config?: Record<string, string> }): Promise<Session>
  rename(req: { id: string; title: string }): Promise<Session>
  delete(req: { id: string }): Promise<{}>

  /** The conversation: snapshot (last ~100 items, never cutting a turn), then whole replacements. Re-watch on drop. */
  watch(req: { id: string }): Stream<WatchEvent>
  /** Older pages: items before `before_seq`, extended to the start of the turn the boundary cuts. */
  list_messages(req: { id: string; before_seq?: number; limit?: number }): Promise<{ messages: Message[]; has_more: boolean }>

  /** Idempotent on client_msg_id. Idle: starts a turn. Running: steer or queue per `delivery` and `control.steer`. */
  send(req: { id: string; client_msg_id: string; content: string; delivery?: 'auto' | 'steer' | 'queue'; attachments?: { path: string; name?: string; mime?: string; size?: number }[] }): Promise<{ message_id: string; delivered: 'started' | 'steered' | 'queued' }>
  /** First answer wins; later ones get failed_precondition, and every watcher sees `control.answered`. */
  answer(req: { id: string; request_id: string; option_id: string }): Promise<{}>
  stop(req: { id: string }): Promise<{}>
  set_config(req: { id: string; config_id: string; value: string }): Promise<Session>
  rewind(req: { id: string; message_id: string; content?: string }): Promise<{ message_id?: string }>
  fork(req: { id: string; message_id: string; title?: string }): Promise<Session>
  compact(req: { id: string; instructions?: string }): Promise<{ message_id: string }>
  steer_queued(req: { id: string; client_msg_id: string }): Promise<{ delivered: 'steered' }>
  unqueue(req: { id: string; client_msg_id: string }): Promise<{}>
}

/** For reference: what `control` carries is answered by the calls above, never polled. */
export type ControlFields = keyof Control

// aa.v3.Terminals (attach = duplex byte stream) and aa.v3.Device (status, list_dirs, read_file, git_status, git_diff,
// upload/download for attachments) follow Effi Cloud's shapes as well; out of scope for this PoC.
