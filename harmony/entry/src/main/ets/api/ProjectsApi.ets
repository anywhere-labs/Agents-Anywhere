import { HttpTransport } from './HttpTransport';
import { encodeUrlComponent } from './ApiUrls';
import {
  parseRemoteProjectEnvelope, parseRemoteProjectList, RemoteProjectEnvelopeDto,
  RemoteProjectListDto,
} from './ProjectsDtos';
import { AgentProject } from '../model/AgentSession';

/**
 * Project resource client.
 *
 * Port of the project portion of `api/SessionsApi.kt` (`ProjectsApi` on Android
 * is the same module). Project-scoped session pages stay in `SessionsApi`
 * because they return sessions.
 */
export class ProjectsApi {
  private readonly transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.transport = transport;
  }

  /** `GET /projects`. */
  async list(serverUrl: string, token: string): Promise<AgentProject[]> {
    const body: Object = await this.transport.getJson(serverUrl, '/projects', token);
    return parseRemoteProjectList(body as RemoteProjectListDto);
  }

  /**
   * `POST /projects`.
   *
   * `manuallyCreated` distinguishes a project the user created from one derived
   * from a workspace: the new-session flow passes `false`, the "New project"
   * screen keeps the default, exactly as Android's two call sites do.
   */
  async create(
    serverUrl: string,
    token: string,
    name: string,
    connectorId: string,
    workspacePath: string,
    manuallyCreated: boolean = true,
  ): Promise<AgentProject> {
    const body: ProjectCreateRequest = {
      name: name,
      connectorId: connectorId,
      workspacePath: workspacePath,
      manuallyCreated: manuallyCreated,
    };
    const response: Object = await this.transport.postJson(serverUrl, '/projects', token, body);
    return parseRemoteProjectEnvelope(response as RemoteProjectEnvelopeDto);
  }

  /** `PATCH /projects/{id}`. Only the provided keys are sent. */
  async update(
    serverUrl: string,
    token: string,
    projectId: string,
    name: string | null = null,
    pinned: boolean | null = null,
  ): Promise<AgentProject> {
    const body: ProjectPatchRequest = {};
    if (name !== null) {
      body.name = name;
    }
    if (pinned !== null) {
      body.pinned = pinned;
    }
    const response: Object = await this.transport.patchJson(
      serverUrl, `/projects/${encodeUrlComponent(projectId)}`, token, body,
    );
    return parseRemoteProjectEnvelope(response as RemoteProjectEnvelopeDto);
  }
}

interface ProjectCreateRequest {
  name: string;
  connectorId: string;
  workspacePath: string;
  manuallyCreated: boolean;
}

interface ProjectPatchRequest {
  name?: string;
  pinned?: boolean;
}
