import { CollabError } from '../../domain/collab/index.js'
import type { SupervisionService } from './supervision-service.js'
import type { ReviewService } from './review-service.js'

/**
 * The people's side of collaboration on the supervisor's device (`GET /sessions/{id}/collab`, `POST
 * .../collab/supervisions`, `PATCH .../collab/supervisions/{sid}`). Structurally the inbound `CollabClientApi`.
 */
export class CollabPeopleApi {
  public constructor(
    private readonly supervisions: SupervisionService,
    /** Whether the session's Agent gets the collaboration tools (settings on, its Runtime can host them). */
    private readonly available: (sessionId: string) => Promise<boolean>,
    private readonly review?: ReviewService,
  ) {}

  public async view(sessionId: string): Promise<Record<string, unknown>> {
    const [supervision, review] = await Promise.all([
      this.available(sessionId).catch(() => false).then(available => this.supervisions.view(sessionId, available)),
      this.review?.read(sessionId),
    ])
    return { ...supervision, ...(review != null ? { review } : {}) }
  }

  public async supervise(caller: { readonly clientId: string; readonly agent?: unknown }, supervisorSessionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    // An Agent sets up supervisions with aa_supervise (own sessions only); this route is a person's.
    if (caller.agent != null) throw new CollabError('agent_authority_exceeded', 'An Agent cannot set up supervisions through this route.')
    return this.supervisions.superviseByPerson(supervisorSessionId, body)
  }

  public async updateSupervision(caller: { readonly clientId: string; readonly agent?: unknown }, supervisorSessionId: string, supervisionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (caller.agent != null) throw new CollabError('agent_authority_exceeded', 'An Agent cannot change supervisions through this route.')
    return this.supervisions.updateByPerson(supervisorSessionId, supervisionId, body)
  }
}
