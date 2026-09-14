import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import {
  runtimePermissionDescriptionResource, runtimePermissionLabelResource,
} from '../../designsystem/RuntimePermissionLocalization';
import { runtimePermissionTranslation } from '../../../feature/sessiondetail/RuntimePermissionTranslation';
import {
  RuntimeModel, RuntimeModelCatalog, RuntimePermission, RuntimePermissionCatalog, RuntimeReasoning,
} from '../../../api/RuntimeCatalogDtos';
import { RemoteRuntimeCapabilitySet } from '../../../api/RuntimeDtos';
import { RemoteDeviceRuntimeList } from '../../../api/DevicesDtos';
import { AgentDevice, AgentProject } from '../../../model/AgentSession';
import { SessionsState } from '../../../feature/sessions/SessionsState';
import { NewSessionPreference, NewSessionPreferenceStore } from '../../../feature/sessions/NewSessionPreferenceStore';
import { NewSessionRuntimeSelectionState } from '../../../feature/sessions/NewSessionRuntimeSelectionState';
import { activeNewSessionRuntimes } from '../../../feature/sessions/NewSessionRuntimeInventory';
import { NewSessionRuntimeInventory } from '../../../feature/sessions/NewSessionRuntimeInventoryLoader';
import {
  availableProjectName, workspacePathKey, workspaceProject, workspaceProjectName,
} from '../../../feature/sessions/NewSessionWorkspaces';
import { AAApiError } from '../../../api/ApiError';
import { SIDEBAR_VIEW_SESSION } from '../../../storage/UiPreferences';
import { ProfileDialogButton, ProfileDialogFrame } from '../profile/ProfileDialogs';
import { NewProjectScreen } from './NewProjectScreen';
import { NewSessionDraft } from '../../../feature/sessions/NewSessionDraft';
import { NewSessionDirectory, NewSessionPathEntry } from '../../../feature/sessions/NewSessionState';
import {
  canonicalRemoteDirectoryPath, displayRemotePath, isSelectableRemoteDirectory, isWindowsDeviceOs,
  normalizeRemotePath, remoteFileRequest, remoteParentPath,
} from '../../../feature/files/RemoteFileNavigation';
import { AALog } from '../../../common/AAAppLog';
import { NewSessionHeader } from './NewSessionHeader';
import { StartChatButton } from './NewSessionComponents';
import {
  NewSessionConfigurationCard, NewSessionConfigurationField, NewSessionConfigurationKey,
  NewSessionConfigurationOption,
} from './NewSessionConfigurationCard';
import { NewSessionPathSection } from './NewSessionPathSection';
import { NewSessionWorkspaceSection, WorkspaceChoice } from './NewSessionWorkspaceSection';
import { NewSessionSetupReason, NewSessionSetupState, newSessionSetupState } from './NewSessionSetupState';
import { NewSessionSetupPanel } from './NewSessionSetupPanel';
import { resolveString, resolveStringWith } from '../../../common/AAResources';

/**
 * The new-session page.
 *
 * Port of `ui/screens/home/NewSessionScreen.kt`.
 *
 * Android expresses this page's lifecycle as a dozen `LaunchedEffect`s. ArkUI has
 * no equivalent primitive, so the same work hangs off two triggers instead:
 *
 *  - `devicesSignature` is a `@Watch`ed prop the app recomputes whenever the
 *    device list or an online flag changes; it starts the pull chain
 *    (device → inventory → runtime details → workspace default);
 *  - the inventory loader's `onChanged` callback bumps a local revision, so a
 *    connector that answers later re-runs the same chain.
 *
 * The page hosts two modes. Normally it picks a device, an agent and a workspace
 * and hands a draft to the app. With `projectOnly` set — how
 * `AppDestination.NewProject` opens it — the agent and workspace rows give way to
 * the project editor, and the page returns to the session list once the project
 * exists. Tapping "create project" in the workspace list enters the same editor
 * in place, which is Android's `creatingProject`.
 */
@Component
export struct NewSessionScreen {
  colors: AAColors = AA_LIGHT_COLORS;
  state: SessionsState = SessionsState.empty();
  /** Recomputes whenever the device list or an online flag changes. */
  @Prop @Watch('onDevicesChanged') devicesSignature: string = '';
  serverUrl: string = '';
  userId: string = '';
  devicesRefreshing: boolean = false;

  onBack: () => void = () => {};
  /** Split layout: the header's leading glyph folds the shell's sidebar. */
  sidebarToggle: boolean = false;
  onToggleSidebar: () => void = () => {};
  onOpenDevices: () => void = () => {};
  onRefreshDevices: () => void = () => {};
  onListDirectory: (deviceId: string, root: string, path: string) => Promise<NewSessionDirectory> =
    () => Promise.reject(new Error('Directory listing is not connected.'));
  onListRuntimes: (deviceId: string) => Promise<RemoteDeviceRuntimeList> =
    () => Promise.reject(new Error('Runtime listing is not connected.'));
  onLoadRuntimeCapabilities: (deviceId: string, runtimeId: string) => Promise<RemoteRuntimeCapabilitySet> =
    () => Promise.reject(new Error('Runtime capabilities are not connected.'));
  onLoadModelCatalog: (deviceId: string, runtimeId: string) => Promise<RuntimeModelCatalog> =
    () => Promise.reject(new Error('The model catalog is not connected.'));
  onLoadPermissionCatalog: (deviceId: string, runtimeId: string) => Promise<RuntimePermissionCatalog> =
    () => Promise.reject(new Error('The permission catalog is not connected.'));
  /** Android's `onPrepareSession`: hands the prepared draft to the app. */
  onPrepareSession: (draft: NewSessionDraft) => void = () => {};
  /** True when the page was opened as `AppDestination.NewProject`. */
  projectOnly: boolean = false;
  /** Android's `onCreateProject`: creates the project for a directory. */
  onCreateProject: (name: string, connectorId: string, path: string) => Promise<AgentProject> =
    () => Promise.reject(new Error('Project creation is not connected.'));
  /** Android's `onLoadProjects`: re-reads the workspace owners. */
  onLoadProjects: () => Promise<AgentProject[]> =
    () => Promise.reject(new Error('Loading projects is not connected.'));
  /** `"project"` or `"session"`; only project mode offers project creation. */
  sidebarViewMode: string = 'project';

  @State private title: string = '';
  @State private editingTitle: boolean = false;
  @State private selectedDeviceId: string = '';
  @State private selectedWorkspacePath: string = '';
  @State private homePath: string = '';
  @State private currentPath: string = '~';
  @State private choosePath: boolean = false;
  @State private pathEntries: NewSessionPathEntry[] = [];
  @State private pathLoading: boolean = false;
  @State private pathError: string = '';
  @State private expandedConfiguration: number = -1;
  /** Bumped when the selection or the inventory changes, so `build` re-runs. */
  @State private revision: number = 0;
  /** True while the project editor replaces the picker. */
  @State private creatingProject: boolean = false;
  @State private projectName: string = '';
  @State private projectCreating: boolean = false;
  @State private projectCreateError: string = '';
  /** The project that already owns the chosen directory, awaiting confirmation. */
  @State private workspaceConflict: AgentProject | null = null;

  private selection: NewSessionRuntimeSelectionState = NewSessionRuntimeSelectionState.empty();
  private readonly inventory: NewSessionRuntimeInventory = new NewSessionRuntimeInventory();
  private preference: NewSessionPreference | null = null;
  private preferenceStore: NewSessionPreferenceStore | null = null;
  private directoryRequestId: number = 0;
  private retryDirectoryPath: string = '~';
  /** A project created here, shown before the next list refresh returns it. */
  private localProject: AgentProject | null = null;
  /** True once the project name was typed, which stops the derived name. */
  private nameEdited: boolean = false;
  /** Snapshots taken when the editor opens, so cancelling restores the picker. */
  private previousDeviceId: string = '';
  private previousPath: string = '';
  private previousSelection: NewSessionRuntimeSelectionState | null = null;

  aboutToAppear(): void {
    this.title = resolveString($r('app.string.new_session_title'));
    if (this.projectOnly) {
      this.title = resolveString($r('app.string.new_session_create_project'));
      this.creatingProject = true;
    }
    this.preferenceStore = new NewSessionPreferenceStore(this.serverUrl, this.userId);
    const stored: NewSessionPreference | null = this.preferenceStore.read();
    this.preference = stored;
    if (stored !== null) {
      this.selection = new NewSessionRuntimeSelectionState({
        connectorId: stored.connectorId,
        selectedRuntimeId: stored.runtimeId,
        selectionHints: stored.selections,
      });
    }
    this.inventory.onChanged = () => this.onInventoryChanged();
    this.onDevicesChanged();
    // Android skips the pull-to-refresh kick when the page is project-only.
    if (!this.projectOnly) {
      this.onRefreshDevices();
    }
  }

  // ------------------------------------------------------------ devices

  private onlineDevices(): AgentDevice[] {
    return this.state.devices.filter((device: AgentDevice) => device.online);
  }

  /** The devices that can host a session: online, with a running agent. */
  private capableDevices(): AgentDevice[] {
    const result: AgentDevice[] = [];
    for (const device of this.onlineDevices()) {
      if (this.inventory.errors.has(device.id)) {
        continue;
      }
      const list = this.inventory.listFor(device.id);
      if (list !== null && activeNewSessionRuntimes(list.runtimes).length > 0) {
        result.push(device);
      }
    }
    return result;
  }

  /**
   * Android's `devices`: while the project editor is open every online device can
   * host a project, otherwise only devices that reported a running agent.
   */
  private devicePool(): AgentDevice[] {
    if (this.creatingProject) {
      return this.onlineDevices();
    }
    return this.capableDevices();
  }

  private selectedDevice(): AgentDevice | null {
    for (const device of this.onlineDevices()) {
      if (device.id === this.selectedDeviceId) {
        return device;
      }
    }
    return null;
  }

  private selectedDeviceOs(): string | null {
    const device: AgentDevice | null = this.selectedDevice();
    return device === null ? null : device.deviceOs;
  }

  private firstInventoryError(): string {
    for (const message of this.inventory.errors.values()) {
      return message;
    }
    return '';
  }

  /** Android's device effect: keep the page on a usable device. */
  private pickDevice(): void {
    const pool: AgentDevice[] = this.devicePool();
    const online: AgentDevice[] = this.onlineDevices();
    const stored: NewSessionPreference | null = this.preference;
    let next: string = '';
    // The project editor prefers the device already on screen over the stored
    // one, because the user may have just switched it in the configuration card.
    const preferred: string = stored === null ? '' : stored.connectorId;
    if (this.creatingProject) {
      if (pool.some((device) => device.id === this.selectedDeviceId)) {
        next = this.selectedDeviceId;
      }
      if (next.length === 0 && pool.some((device) => device.id === preferred)) {
        next = preferred;
      }
    } else {
      if (pool.some((device) => device.id === preferred)) {
        next = preferred;
      }
      if (next.length === 0 && pool.some((device) => device.id === this.selectedDeviceId)) {
        next = this.selectedDeviceId;
      }
    }
    if (next.length === 0 && pool.length > 0) {
      next = pool[0].id;
    }
    if (next.length === 0 && online.some((device) => device.id === this.selectedDeviceId)) {
      // A connected device can list directories while the agent check runs.
      next = this.selectedDeviceId;
    }
    if (next.length === 0 && online.some((device) => device.id === preferred)) {
      next = preferred;
    }
    if (next.length === 0 && online.length > 0) {
      next = online[0].id;
    }
    if (next !== this.selectedDeviceId) {
      this.selectDevice(next, false);
    }
  }

  private selectDevice(deviceId: string, persist: boolean): void {
    if (this.selectedDeviceId !== deviceId) {
      this.selectedDeviceId = deviceId;
      this.selectedWorkspacePath = '';
      this.currentPath = '';
      this.homePath = '';
      this.directoryRequestId += 1;
      this.pathEntries = [];
      this.pathLoading = false;
      this.pathError = '';
      this.projectCreateError = '';
      this.choosePath = false;
      // Android's directory effect is keyed on the selected device, so a switch
      // re-resolves the home directory (or re-enters the project browser).
      this.loadInitialDirectory();
    }
    if (deviceId.length > 0) {
      if (!this.creatingProject) {
        this.adoptInventory(deviceId);
      }
      if (persist) {
        this.persistSelection(NewSessionConfigurationKey.Device);
      }
    }
    this.revision += 1;
  }

  /** Android's inventory effect: adopt whatever the loader has for this device. */
  private adoptInventory(deviceId: string): void {
    const next: NewSessionRuntimeSelectionState = this.selection.beginRuntimeInventory(deviceId);
    const list = this.inventory.listFor(deviceId);
    const stored: NewSessionPreference | null = this.preference;
    const preferred: string = stored !== null && stored.connectorId === deviceId
      ? stored.runtimeId : '';
    this.selection = list === null ? next : next.replaceRuntimeInventory(list, preferred);
    const failure: string | undefined = this.inventory.errors.get(deviceId);
    if (failure !== undefined) {
      this.selection = this.selection.failRuntimeInventory(deviceId, failure);
    }
  }

  private onDevicesChanged(): void {
    this.startInventory();
    this.pickDevice();
    this.revision += 1;
  }

  private onInventoryChanged(): void {
    this.pickDevice();
    if (this.selectedDeviceId.length > 0 && !this.creatingProject) {
      this.adoptInventory(this.selectedDeviceId);
    }
    this.loadRuntimeDetails();
    this.revision += 1;
  }

  private startInventory(): void {
    if (this.projectOnly) {
      // Android passes an empty connector list here, so opening the project
      // editor never asks any device for its runtimes.
      this.loadInitialDirectory();
      return;
    }
    const ids: string[] = this.onlineDevices().map((device: AgentDevice) => device.id);
    if (ids.length === 0) {
      this.loadRuntimeDetails();
      return;
    }
    const version: number = this.inventory.refreshVersion();
    void this.inventory.loadAll(
      ids,
      (deviceId: string) => this.onListRuntimes(deviceId),
      resolveString($r('app.string.new_session_runtime_load_failed')),
      version,
    ).then(() => {
      this.loadInitialDirectory();
      this.loadRuntimeDetails();
      this.revision += 1;
    }).catch((error: Error) => {
      AALog.warn(`Runtime inventory failed: ${error.message}`);
    });
  }

  /**
   * Android's runtime-details effect: capabilities first, then the two catalogs
   * the capabilities allow. The request key drops an answer for a runtime the
   * user has already left.
   */
  private loadRuntimeDetails(): void {
    const device: AgentDevice | null = this.selectedDevice();
    if (device === null || this.creatingProject || this.setupState() !== null) {
      return;
    }
    if (this.selection.connectorId !== device.id || this.selection.runtimesLoading) {
      return;
    }
    const runtimeId: string | null = this.selection.selectedRuntimeId;
    if (runtimeId === null || this.selection.capabilities.loading) {
      return;
    }
    if (this.selection.capabilities.fresh()) {
      // Already loaded for this runtime; nothing to do.
      return;
    }
    const connectorId: string = device.id;
    this.selection = this.selection.beginRuntimeDetails();
    const requestKey = this.selection.requestKey;
    if (requestKey === null) {
      return;
    }
    void this.onLoadRuntimeCapabilities(connectorId, runtimeId)
      .then((set: RemoteRuntimeCapabilitySet) => {
        this.selection = this.selection.applyCapabilities(requestKey, set);
        if (!requestKey.equals(this.selection.requestKey)) {
          return;
        }
        if (this.selection.canUseModelCatalog()) {
          void this.onLoadModelCatalog(connectorId, runtimeId).then((catalog: RuntimeModelCatalog) => {
            this.selection = this.selection.applyModelCatalog(requestKey, catalog);
            this.revision += 1;
          }).catch(() => {
            this.selection = this.selection.failModelCatalog(
              requestKey, resolveString($r('app.string.new_session_model_catalog_failed')),
            );
            this.revision += 1;
          });
        }
        if (this.selection.canUsePermissionCatalog()) {
          void this.onLoadPermissionCatalog(connectorId, runtimeId)
            .then((catalog: RuntimePermissionCatalog) => {
              this.selection = this.selection.applyPermissionCatalog(requestKey, catalog);
              this.revision += 1;
            }).catch(() => {
              this.selection = this.selection.failPermissionCatalog(
                requestKey, resolveString($r('app.string.new_session_permission_catalog_failed')),
              );
              this.revision += 1;
            });
        }
        this.revision += 1;
      })
      .catch(() => {
        this.selection = this.selection.failCapabilities(
          requestKey, resolveString($r('app.string.new_session_capabilities_failed')),
        );
        this.revision += 1;
      });
  }

  // ------------------------------------------------------------ directories

  /**
   * Android's directory effect.
   *
   * While the project editor is open the current directory *is* the project
   * target, so the listing starts there and is selected; otherwise the home
   * directory is resolved over the API so the picker can offer it.
   */
  private loadInitialDirectory(): void {
    const device: AgentDevice | null = this.selectedDevice();
    const startPath: string = this.currentPath.length > 0
      ? this.currentPath
      : (this.homePath.length > 0 ? this.homePath : '~');
    this.homePath = '';
    this.directoryRequestId += 1;
    this.pathEntries = [];
    this.pathLoading = false;
    if (device === null) {
      return;
    }
    if (this.creatingProject) {
      void this.loadDirectory(startPath, true);
      return;
    }
    this.loadHomePath(device);
  }

  /** Resolves the home directory over the API and defaults the workspace to it. */
  private loadHomePath(device: AgentDevice): void {
    const deviceId: string = device.id;
    const requestId: number = this.directoryRequestId + 1;
    this.directoryRequestId = requestId;
    void this.onListDirectory(deviceId, '~', '.').then((directory: NewSessionDirectory) => {
      if (requestId !== this.directoryRequestId || this.selectedDeviceId !== deviceId) {
        return;
      }
      const resolved: string = directory.path.length > 0 ? directory.path : '~';
      this.homePath = resolved;
      this.applyHomeWorkspace(device, resolved);
      this.revision += 1;
    }).catch((error: Error) => {
      AALog.debug(`Resolving the home directory failed: ${error.message}`);
    });
  }

  /** Android's home-workspace effect: default to the home project or directory. */
  private applyHomeWorkspace(device: AgentDevice, resolved: string): void {
    if (this.creatingProject || this.choosePath || this.selectedWorkspacePath.length > 0) {
      return;
    }
    if (!this.hasAvailableSelectedRuntime(device)) {
      return;
    }
    const project: AgentProject | null = this.projectForPath(device.id, resolved, device.deviceOs);
    this.selectedWorkspacePath = project === null ? resolved : project.workspacePath;
    this.currentPath = this.selectedWorkspacePath;
  }

  /** Whether the selected runtime is usable on this device right now. */
  private hasAvailableSelectedRuntime(device: AgentDevice | null): boolean {
    if (device === null) {
      return false;
    }
    if (this.selection.connectorId !== device.id || this.selection.runtimesLoading
      || this.selection.runtimesErrorMessage !== null) {
      return false;
    }
    const selectedId: string | null = this.selection.selectedRuntimeId;
    if (selectedId === null) {
      return false;
    }
    const list = this.inventory.listFor(device.id);
    if (list === null) {
      return false;
    }
    return activeNewSessionRuntimes(list.runtimes).some((runtime) => runtime.id === selectedId);
  }

  /**
   * Android's `projects`: the Server's list plus a project created on this page,
   * which is shown until the next list refresh contains it.
   */
  private projectsList(): AgentProject[] {
    const local: AgentProject | null = this.localProject;
    if (local === null) {
      return this.state.projects;
    }
    for (const project of this.state.projects) {
      if (project.id === local.id) {
        return this.state.projects;
      }
    }
    return this.state.projects.concat([local]);
  }

  private projectForPath(connectorId: string, path: string, deviceOs: string | null): AgentProject | null {
    return workspaceProject(this.projectsList(), connectorId, path, deviceOs);
  }

  /**
   * Keeps the project name in step with the chosen directory.
   *
   * Android's effect only runs while the editor is open and the name was never
   * typed: landing on a directory proposes that directory's name, and a name the
   * Server already holds is suffixed so the create does not collide.
   */
  private syncProjectName(): void {
    if (!this.creatingProject || this.nameEdited) {
      return;
    }
    const path: string = this.selectedWorkspacePath;
    if (path.length === 0) {
      this.projectName = '';
      return;
    }
    const projects: AgentProject[] = this.projectsList();
    const existing: AgentProject | null =
      workspaceProject(projects, this.selectedDeviceId, path, this.selectedDeviceOs());
    const base: string = existing === null ? workspaceProjectName(path) : existing.name;
    this.projectName = availableProjectName(
      base, projects, existing === null ? null : existing.id,
    );
  }

  /** Android's `loadDirectory`: a listing, guarded by a request id. */
  private async loadDirectory(targetPath: string, select: boolean): Promise<void> {
    const device: AgentDevice | null = this.selectedDevice();
    if (device === null) {
      return;
    }
    const request = remoteFileRequest(targetPath, device.deviceOs, this.currentPath);
    const requestId: number = this.directoryRequestId + 1;
    this.directoryRequestId = requestId;
    this.retryDirectoryPath = targetPath;
    this.pathLoading = true;
    this.pathError = '';
    try {
      const directory: NewSessionDirectory =
        await this.onListDirectory(device.id, request.root, request.path);
      if (requestId !== this.directoryRequestId || this.selectedDeviceId !== device.id) {
        return;
      }
      const nextPath: string = canonicalRemoteDirectoryPath(request, directory.path, device.deviceOs);
      this.currentPath = nextPath;
      const entries: NewSessionPathEntry[] = [];
      for (const entry of directory.entries) {
        entries.push(new NewSessionPathEntry(
          entry.name, normalizeRemotePath(entry.path), entry.isDirectory, entry.size,
        ));
      }
      this.pathEntries = entries;
      if (select && isSelectableRemoteDirectory(nextPath, device.deviceOs)) {
        this.selectedWorkspacePath = nextPath;
      }
      if (this.creatingProject) {
        // Android's name effect is keyed on the workspace path.
        this.syncProjectName();
      }
    } catch (error) {
      if (requestId !== this.directoryRequestId || this.selectedDeviceId !== device.id) {
        return;
      }
      this.pathEntries = [];
      this.pathError = error instanceof Error
        ? error.message : resolveString($r('app.string.new_session_load_directory_failed'));
    } finally {
      if (requestId === this.directoryRequestId && this.selectedDeviceId === device.id) {
        this.pathLoading = false;
      }
    }
  }

  // ------------------------------------------------------------ selection

  private persistSelection(key: NewSessionConfigurationKey): void {
    const store: NewSessionPreferenceStore | null = this.preferenceStore;
    if (store === null || this.selection.connectorId !== this.selectedDeviceId) {
      return;
    }
    const runtimeId: string | null = this.selection.selectedRuntimeId;
    if (runtimeId === null) {
      return;
    }
    let next: NewSessionPreference | null = null;
    if (key === NewSessionConfigurationKey.Device || key === NewSessionConfigurationKey.Agent) {
      next = store.saveTarget(this.selectedDeviceId, runtimeId);
    } else if (key === NewSessionConfigurationKey.Model || key === NewSessionConfigurationKey.Effort) {
      if (this.selection.modelCatalog.fresh()) {
        const model: string | null = this.selection.selectedModelSelectionId();
        next = model === null ? null : store.saveModel(this.selectedDeviceId, runtimeId, model);
      }
    } else if (key === NewSessionConfigurationKey.Permission
      && this.selection.permissionCatalog.fresh()) {
      const permission: string | null = this.selection.selectedPermissionSelectionId();
      next = permission === null ? null : store.savePermission(
        this.selectedDeviceId, runtimeId, permission,
      );
    }
    if (next !== null) {
      this.preference = next;
    }
  }

  private selectConfigurationOption(key: NewSessionConfigurationKey, optionId: string): void {
    if (key === NewSessionConfigurationKey.Device) {
      this.selectDevice(optionId, true);
      return;
    }
    if (key === NewSessionConfigurationKey.Agent) {
      this.selection = this.selection.selectRuntime(optionId);
    } else if (key === NewSessionConfigurationKey.Model) {
      this.selection = this.selection.selectModel(optionId);
    } else if (key === NewSessionConfigurationKey.Effort) {
      this.selection = this.selection.selectReasoning(optionId);
    } else if (key === NewSessionConfigurationKey.Permission) {
      this.selection = this.selection.selectPermission(optionId);
    }
    this.persistSelection(key);
    this.revision += 1;
  }

  // ------------------------------------------------------------ fields

  private catalogsLoading(): boolean {
    if (this.selection.selectedRuntime() === null) {
      return false;
    }
    return !this.selection.capabilities.loaded || this.selection.capabilities.loading
      || this.selection.modelCatalog.loading || this.selection.permissionCatalog.loading;
  }

  private localizedPermissionLabel(runtimeType: string, permission: RuntimePermission): string {
    const translation = runtimePermissionTranslation(runtimeType, permission.id, permission.metadata);
    const resource: Resource | null = runtimePermissionLabelResource(translation);
    return resource === null ? permission.displayName : resolveString(resource);
  }

  private localizedPermissionDescription(runtimeType: string, permission: RuntimePermission): string {
    const translation = runtimePermissionTranslation(runtimeType, permission.id, permission.metadata);
    const resource: Resource | null = runtimePermissionDescriptionResource(translation);
    if (resource !== null) {
      return resolveString(resource);
    }
    return permission.description === null ? '' : permission.description;
  }

  /** Android's `configurationFields`, in the same order and with the same text. */
  private configurationFields(): NewSessionConfigurationField[] {
    const setup: NewSessionSetupState | null = this.setupState();
    const checkingDevices: boolean = setup !== null
      && setup.reason === NewSessionSetupReason.CheckingDevices;
    const checkingAgents: boolean = setup !== null
      && setup.reason === NewSessionSetupReason.CheckingAgents;
    const loadingLabel: string = resolveString($r('app.string.new_session_catalog_loading'));
    const unavailableLabel: string = resolveString($r('app.string.new_session_catalog_unavailable'));
    const catalogsLoading: boolean = this.catalogsLoading();
    const device: AgentDevice | null = this.selectedDevice();

    const deviceOptions: NewSessionConfigurationOption[] = [];
    // iOS's target button offers every connector and is live whenever one is
    // online (`NewSessionView` disables it only while creating), so a device
    // without a running Agent can still be picked — the page then explains what
    // that device is missing instead of leaving the row inert.
    const online: AgentDevice[] = this.onlineDevices();
    for (const entry of online) {
      deviceOptions.push(new NewSessionConfigurationOption(entry.id, entry.name));
    }
    const fields: NewSessionConfigurationField[] = [new NewSessionConfigurationField(
      NewSessionConfigurationKey.Device,
      resolveString($r('app.string.new_session_device')),
      device === null ? resolveString($r('app.string.new_session_no_device')) : device.name,
      device === null ? '' : device.id,
      deviceOptions,
      online.length > 0,
      checkingDevices,
    )];

    const runtimeOptions: NewSessionConfigurationOption[] = [];
    for (const runtime of this.selection.runtimes) {
      runtimeOptions.push(new NewSessionConfigurationOption(runtime.id, runtime.displayName));
    }
    const selectedRuntime = this.selection.selectedRuntime();
    fields.push(new NewSessionConfigurationField(
      NewSessionConfigurationKey.Agent,
      resolveString($r('app.string.new_session_agent')),
      selectedRuntime === null
        ? resolveString($r('app.string.new_session_no_agent')) : selectedRuntime.displayName,
      selectedRuntime === null ? '' : selectedRuntime.id,
      runtimeOptions,
      device !== null && runtimeOptions.length > 0,
      checkingDevices || checkingAgents || this.selection.runtimesLoading,
    ));

    if (selectedRuntime !== null
      && (catalogsLoading || this.selection.canUseModelCatalog()
        || this.selection.modelCatalog.data !== null)) {
      const catalog: RuntimeModelCatalog | null = this.selection.modelCatalog.data;
      const models: RuntimeModel[] = catalog === null ? [] : catalog.models;
      const modelOptions: NewSessionConfigurationOption[] = [];
      for (const model of models) {
        const usable: boolean = model.enabled && (
          (model.selectionId !== null && model.selectionId.trim().length > 0)
          || model.reasoningItems.some((item) => item.enabled && item.selectionId.trim().length > 0)
        );
        modelOptions.push(new NewSessionConfigurationOption(model.id, model.displayName, '', usable));
      }
      const selectedModel: RuntimeModel | null = this.selection.selectedModel();
      fields.push(new NewSessionConfigurationField(
        NewSessionConfigurationKey.Model,
        resolveString($r('app.string.new_session_model')),
        catalogsLoading ? loadingLabel
          : (selectedModel === null ? unavailableLabel : selectedModel.displayName),
        selectedModel === null ? '' : selectedModel.id,
        modelOptions,
        this.selection.modelCatalog.fresh(),
        catalogsLoading,
      ));

      const reasoning: RuntimeReasoning[] = this.selection.reasoningOptions();
      const reasoningOptions: NewSessionConfigurationOption[] = [];
      for (const effort of reasoning) {
        reasoningOptions.push(new NewSessionConfigurationOption(
          effort.id,
          effort.displayName,
          effort.enabled
            ? (effort.description === null ? '' : effort.description)
            : (effort.disabledReason === null ? '' : effort.disabledReason),
          effort.enabled && effort.id.length > 0 && effort.selectionId.trim().length > 0,
        ));
      }
      const selectedReasoning: RuntimeReasoning | null = this.selection.selectedReasoning();
      let effortValue: string = unavailableLabel;
      if (catalogsLoading) {
        effortValue = loadingLabel;
      } else if (selectedReasoning !== null) {
        effortValue = selectedReasoning.displayName;
      } else if (reasoning.length === 0) {
        effortValue = resolveString($r('app.string.session_runtime_effort_default'));
      }
      fields.push(new NewSessionConfigurationField(
        NewSessionConfigurationKey.Effort,
        resolveString($r('app.string.new_session_reasoning')),
        effortValue,
        selectedReasoning === null ? '' : selectedReasoning.id,
        reasoningOptions,
        this.selection.modelCatalog.fresh() && reasoning.length > 0,
        catalogsLoading,
      ));
    }

    if (selectedRuntime !== null
      && (catalogsLoading || this.selection.canUsePermissionCatalog()
        || this.selection.permissionCatalog.data !== null)) {
      const catalog: RuntimePermissionCatalog | null = this.selection.permissionCatalog.data;
      const permissions: RuntimePermission[] = catalog === null ? [] : catalog.permissions;
      let runtimeType: string = selectedRuntime.type;
      if (catalog !== null) {
        runtimeType = catalog.runtime.length > 0 ? catalog.runtime : catalog.runtimeType;
      }
      const permissionOptions: NewSessionConfigurationOption[] = [];
      for (const permission of permissions) {
        permissionOptions.push(new NewSessionConfigurationOption(
          permission.id,
          this.localizedPermissionLabel(runtimeType, permission),
          permission.enabled
            ? this.localizedPermissionDescription(runtimeType, permission)
            : (permission.disabledReason === null ? '' : permission.disabledReason),
          permission.enabled && permission.id.length > 0 && permission.selectionId.trim().length > 0,
        ));
      }
      const selectedPermission: RuntimePermission | null = this.selection.selectedPermission();
      let permissionValue: string = unavailableLabel;
      if (catalogsLoading) {
        permissionValue = loadingLabel;
      } else if (selectedPermission !== null) {
        permissionValue = this.localizedPermissionLabel(runtimeType, selectedPermission);
      }
      fields.push(new NewSessionConfigurationField(
        NewSessionConfigurationKey.Permission,
        resolveString($r('app.string.session_runtime_permission_mode')),
        permissionValue,
        selectedPermission === null ? '' : selectedPermission.id,
        permissionOptions,
        this.selection.permissionCatalog.fresh(),
        catalogsLoading,
      ));
    }
    return fields;
  }

  // ------------------------------------------------------------ state

  /**
   * Android's `setupState = if (creatingProject) null else …`: the editor never
   * shows the "checking devices" panel, because it does not need an agent.
   */
  private setupState(): NewSessionSetupState | null {
    if (this.creatingProject) {
      return null;
    }
    return newSessionSetupState(
      this.state,
      this.inventory,
      null,
      this.selectedDeviceId.length > 0 ? this.selectedDeviceId : null,
      this.hasAvailableSelectedRuntime(this.selectedDevice()),
    );
  }

  private canStart(): boolean {
    if (this.setupState() !== null) {
      return false;
    }
    const device: AgentDevice | null = this.selectedDevice();
    if (device === null || this.selection.connectorId !== device.id) {
      return false;
    }
    if (this.selection.selectedRuntime() === null || !this.selection.readyForCreate()) {
      return false;
    }
    return this.workspaceReady();
  }

  private canUseCurrentPath(): boolean {
    return isSelectableRemoteDirectory(this.currentPath, this.selectedDeviceOs());
  }

  /**
   * Android's `effectiveWorkspacePath`: an open browser makes the directory on
   * screen the target, so confirming it is optional.
   */
  private effectiveWorkspacePath(): string {
    return this.choosePath ? this.currentPath : this.selectedWorkspacePath;
  }

  private workspaceReady(): boolean {
    if (this.choosePath) {
      return this.canUseCurrentPath() && !this.pathLoading && this.pathError.length === 0;
    }
    return this.effectiveWorkspacePath().length > 0;
  }

  /** Android's inline `runtimeError`: why the start button is unavailable. */
  private runtimeError(): string {
    if (this.setupState() !== null || this.inventory.loading()) {
      return '';
    }
    if (this.onlineDevices().length === 0) {
      return resolveString($r('app.string.new_session_no_online_agent'));
    }
    if (this.devicePool().length === 0) {
      const first: string = this.firstInventoryError();
      return first.length > 0 ? first
        : resolveString($r('app.string.new_session_no_attached_agents'));
    }
    if (this.selection.runtimesErrorMessage !== null) {
      return this.selection.runtimesErrorMessage;
    }
    if (!this.selection.runtimesLoading && this.selection.runtimes.length === 0) {
      return resolveString($r('app.string.new_session_no_attached_agents'));
    }
    const runtime = this.selection.selectedRuntime();
    if (runtime !== null) {
      if (!runtime.present) {
        return resolveString($r('app.string.device_runtime_not_present'));
      }
      if (!runtime.configured) {
        return resolveString($r('app.string.device_runtime_not_configured'));
      }
      if (!runtime.active) {
        return resolveString($r('app.string.new_session_runtime_inactive'));
      }
    }
    if (this.selection.capabilities.errorMessage !== null) {
      return resolveString($r('app.string.new_session_capabilities_failed'));
    }
    if (this.selection.modelCatalog.errorMessage !== null) {
      return resolveString($r('app.string.new_session_model_catalog_failed'));
    }
    if (this.selection.permissionCatalog.errorMessage !== null) {
      return resolveString($r('app.string.new_session_permission_catalog_failed'));
    }
    if (this.selection.modelCatalog.stale || this.selection.permissionCatalog.stale) {
      return resolveString($r('app.string.new_session_catalog_stale'));
    }
    return '';
  }

  // ------------------------------------------------------------ start

  private startSession(): void {
    const device: AgentDevice | null = this.selectedDevice();
    const runtime = this.selection.selectedRuntime();
    if (device === null || runtime === null || !this.canStart()) {
      return;
    }
    const workspace: string = this.effectiveWorkspacePath().trim();
    const project: AgentProject | null = workspace.length > 0
      ? this.projectForPath(device.id, workspace, device.deviceOs) : null;
    const store: NewSessionPreferenceStore | null = this.preferenceStore;
    if (store !== null) {
      store.save(device.id, runtime.id, this.selection.selections());
    }
    const knownIds: Set<string> = new Set();
    for (const session of this.state.sessions.concat(this.state.archivedSessions)) {
      knownIds.add(session.id);
    }
    const trimmedTitle: string = this.title.trim();
    this.onPrepareSession(new NewSessionDraft(
      device.id,
      runtime.type,
      trimmedTitle.length > 0 ? trimmedTitle : null,
      workspace.length > 0 ? workspace : null,
      device.name,
      runtime.displayName,
      knownIds,
      this.selection.selections(),
      runtime.id,
      runtime.type,
      runtime.displayName,
      this.selection.canUseAttachments(),
      NewSessionDraft.newLocalSessionId(),
      project === null ? '' : project.id,
    ));
  }

  private submitTitle(): void {
    const trimmed: string = this.title.trim();
    this.title = trimmed.length > 0 ? trimmed : resolveString($r('app.string.new_session_title'));
    this.editingTitle = false;
  }

  // ------------------------------------------------------------ projects

  /** Android's `beginProjectCreation`: open the editor over the current page. */
  private beginProjectCreation(): void {
    this.editingTitle = false;
    this.previousDeviceId = this.selectedDeviceId;
    this.previousPath = this.selectedWorkspacePath;
    this.previousSelection = this.selection;
    this.currentPath = this.homePath.length > 0 ? this.homePath : '~';
    this.directoryRequestId += 1;
    this.pathEntries = [];
    this.pathError = '';
    this.selectedWorkspacePath = '';
    this.nameEdited = false;
    this.projectName = '';
    this.projectCreateError = '';
    this.projectCreating = false;
    this.choosePath = false;
    this.creatingProject = true;
    this.expandedConfiguration = -1;
    const online: AgentDevice[] = this.onlineDevices();
    const stored: NewSessionPreference | null = this.preference;
    const preferred: string = stored === null ? '' : stored.connectorId;
    if (online.some((device) => device.id === this.selectedDeviceId)) {
      // Keep the device the user was already looking at.
    } else if (online.some((device) => device.id === preferred)) {
      this.selectedDeviceId = preferred;
    } else if (online.length > 0) {
      this.selectedDeviceId = online[0].id;
    }
    // Android's directory effect is keyed on `creatingProject`, so the browser
    // opens on the current directory with the target selected.
    this.loadInitialDirectory();
    this.syncProjectName();
    this.revision += 1;
  }

  /** True when the browser sits on the directory that would become the project. */
  private directorySelected(): boolean {
    if (this.selectedWorkspacePath.length === 0) {
      return false;
    }
    const deviceOs: string | null = this.selectedDeviceOs();
    return workspacePathKey(this.selectedWorkspacePath, deviceOs)
      === workspacePathKey(this.currentPath, deviceOs);
  }

  private canCreateProject(): boolean {
    return this.projectName.trim().length > 0 && this.directoryReady()
      && this.directorySelected() && !this.projectCreating;
  }

  private directoryReady(): boolean {
    return this.selectedDevice() !== null && this.canUseCurrentPath()
      && !this.pathLoading && this.pathError.length === 0;
  }

  /** Android's `browseDirectory`: clearing the target makes the listing select it. */
  private browseDirectory(targetPath: string): void {
    if (this.projectCreating) {
      return;
    }
    this.selectedWorkspacePath = '';
    this.projectCreateError = '';
    void this.loadDirectory(targetPath, true).then(() => {
      this.syncProjectName();
      this.revision += 1;
    });
  }

  /**
   * Android's `createProject`.
   *
   * The directory is expanded, the project list is re-read (so another client's
   * project on the same directory is not silently renamed), the name is made
   * unique, and — unless the caller already confirmed the rename — a directory
   * that belongs to a differently named project opens the conflict dialog first.
   */
  private createProject(confirmRename: boolean): void {
    const device: AgentDevice | null = this.selectedDevice();
    if (device === null) {
      return;
    }
    const inputPath: string = this.selectedWorkspacePath.trim();
    const inputName: string = this.projectName.trim();
    const useDirectoryName: boolean = !this.nameEdited;
    if (this.projectCreating || inputPath.length === 0 || inputName.length === 0) {
      return;
    }
    this.projectCreating = true;
    this.projectCreateError = '';
    this.revision += 1;
    void this.runCreateProject(device, inputPath, inputName, useDirectoryName, confirmRename);
  }

  private async runCreateProject(
    device: AgentDevice,
    inputPath: string,
    inputName: string,
    useDirectoryName: boolean,
    confirmRename: boolean,
  ): Promise<void> {
    let attemptedName: string = inputName;
    let existingProjectId: string = '';
    try {
      let path: string = inputPath;
      if (path.startsWith('~')) {
        const directory: NewSessionDirectory =
          await this.onListDirectory(device.id, path, '.');
        path = directory.path;
        if (path.length === 0 || path.startsWith('~')) {
          throw new Error(resolveString($r('app.string.workspace_resolve_failed')));
        }
      }
      const latest: AgentProject[] = await this.onLoadProjects();
      const existing: AgentProject | null =
        workspaceProject(latest, device.id, path, device.deviceOs);
      existingProjectId = existing === null ? '' : existing.id;
      const base: string = useDirectoryName
        ? (existing === null ? workspaceProjectName(path) : existing.name) : inputName;
      attemptedName = availableProjectName(
        base, latest, existingProjectId.length > 0 ? existingProjectId : null,
      );
      this.selectedWorkspacePath = path;
      this.projectName = attemptedName;
      if (!confirmRename && existing !== null && existing.name !== attemptedName) {
        this.workspaceConflict = existing;
        this.revision += 1;
        return;
      }
      const project: AgentProject =
        await this.onCreateProject(attemptedName, device.id, path);
      this.localProject = project;
      this.selectDevice(project.connectorId, true);
      this.selectedWorkspacePath = project.workspacePath;
      this.currentPath = project.workspacePath;
      this.expandedConfiguration = -1;
      this.choosePath = false;
      if (this.projectOnly) {
        // Android leaves the page behind entirely in project-only mode.
        this.onBack();
      } else {
        this.creatingProject = false;
        // Android's directory effect is keyed on `creatingProject`, so leaving
        // the editor re-resolves the home directory for the picker.
        this.loadInitialDirectory();
      }
    } catch (error) {
      if (error instanceof AAApiError && error.errorCode === 'project_name_conflict') {
        const latest: AgentProject[] = await this.onLoadProjects().catch(() => this.state.projects);
        attemptedName = availableProjectName(
          attemptedName, latest, existingProjectId.length > 0 ? existingProjectId : null,
          new Set<string>([attemptedName]),
        );
        this.nameEdited = true;
        this.projectName = attemptedName;
        this.projectCreateError = resolveString($r('app.string.project_name_adjusted'));
      } else {
        this.projectCreateError = error instanceof Error && error.message.length > 0
          ? error.message : resolveString($r('app.string.new_session_project_create_failed'));
      }
    } finally {
      this.projectCreating = false;
      this.revision += 1;
    }
  }

  /** Android's `cancelProjectCreation`: restore the picker, or leave the page. */
  private cancelProjectCreation(): void {
    if (this.projectCreating) {
      return;
    }
    if (this.projectOnly) {
      this.onBack();
      return;
    }
    this.selectedDeviceId = this.previousDeviceId;
    this.selectedWorkspacePath = this.previousPath;
    this.currentPath = this.previousPath;
    const previous: NewSessionRuntimeSelectionState | null = this.previousSelection;
    if (previous !== null) {
      this.selection = previous;
    }
    this.expandedConfiguration = -1;
    this.creatingProject = false;
    this.projectCreateError = '';
    this.workspaceConflict = null;
    // Android's directory effect re-runs when `creatingProject` flips back, which
    // restores the picker's home row.
    this.loadInitialDirectory();
    this.revision += 1;
  }

  private pathLabel(): string {
    return displayRemotePath(
      this.selectedWorkspacePath,
      this.currentPath,
      this.selectedDeviceOs(),
      resolveString($r('app.string.files_windows_drives')),
    );
  }

  private parentPath(): string | null {
    return remoteParentPath(
      this.currentPath, this.selectedDeviceOs(), isWindowsDeviceOs(this.selectedDeviceOs()),
    );
  }

  // ------------------------------------------------------------ layout

  build() {
    Column() {
      this.Content()
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.colors.canvas)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  Content() {
    if (this.creatingProject) {
      Stack() {
        NewProjectScreen({
          colors: this.colors,
          deviceField: this.deviceField(),
          deviceMenuExpanded: this.expandedConfiguration === NewSessionConfigurationKey.Device,
          onToggleDevice: () => {
            this.expandedConfiguration =
              this.expandedConfiguration === NewSessionConfigurationKey.Device
                ? -1 : NewSessionConfigurationKey.Device;
          },
          onDismissDevice: () => {
            this.expandedConfiguration = -1;
          },
          onSelectDevice: (deviceId: string) => {
            this.selectDevice(deviceId, false);
          },
          name: this.projectName,
          onNameChange: (value: string) => {
            // Typing the name stops the directory from proposing one.
            this.nameEdited = true;
            this.projectName = value;
            this.projectCreateError = '';
            this.revision += 1;
          },
          creating: this.projectCreating,
          canCreate: this.canCreateProject(),
          errorMessage: this.projectCreateError,
          onBack: () => this.cancelProjectCreation(),
          onCreate: () => this.createProject(false),
        }) {
          this.ProjectDirectorySection()
        }

        if (this.workspaceConflict !== null) {
          this.WorkspaceConflictDialog()
        }
      }
      .width('100%')
      .height('100%')
    } else if (this.setupPageState() !== null) {
      Column() {
        NewSessionHeader({
          colors: this.colors,
          title: resolveString($r('app.string.new_session_title')),
          headerEditing: false,
          editable: false,
          draftTitle: resolveString($r('app.string.new_session_title')),
          onClose: () => this.onBack(),
          sidebarToggle: this.sidebarToggle,
          onToggleSidebar: () => this.onToggleSidebar(),
        })

        NewSessionSetupPanel({
          colors: this.colors,
          state: this.setupPageState() as NewSessionSetupState,
          refreshing: this.devicesRefreshing || this.inventory.pendingInitial.size > 0,
          onOpenDevices: () => this.onOpenDevices(),
          onRetry: () => {
            this.onRefreshDevices();
            this.inventory.refresh();
            this.startInventory();
          },
        })
          .layoutWeight(1)
      }
      .width('100%')
      .height('100%')
      .alignItems(HorizontalAlign.Start)
    } else {
      NewSessionHeader({
        colors: this.colors,
        title: this.title,
        headerEditing: this.editingTitle,
        editable: true,
        draftTitle: this.title,
        onClose: () => this.onBack(),
        sidebarToggle: this.sidebarToggle,
        onToggleSidebar: () => this.onToggleSidebar(),
        onEditToggle: () => {
          if (this.editingTitle) {
            this.submitTitle();
          } else {
            this.editingTitle = true;
          }
        },
        onSubmitTitle: () => this.submitTitle(),
        onTitleChange: (value: string) => {
          this.title = value;
        },
      })

      Column({ space: 18 }) {
        NewSessionConfigurationCard({
          colors: this.colors,
          fields: this.configurationFields(),
          expandedKey: this.expandedConfiguration,
          onToggle: (key: NewSessionConfigurationKey) => {
            this.expandedConfiguration = this.expandedConfiguration === key ? -1 : key;
          },
          onDismiss: () => {
            this.expandedConfiguration = -1;
          },
          onSelect: (key: NewSessionConfigurationKey, optionId: string) => {
            this.selectConfigurationOption(key, optionId);
          },
        })

        if (this.choosePath) {
          NewSessionPathSection({
            colors: this.colors,
            currentPath: this.currentPath,
            currentPathLabel: this.pathLabel(),
            parentPath: this.parentPath(),
            entries: this.pathEntries,
            loading: this.pathLoading,
            errorMessage: this.pathError,
            canUseCurrent: this.canUseCurrentPath(),
            sectionEnabled: this.selectedDevice() !== null,
            collapsible: false,
            title: '',
            hasBack: true,
            hasUseCurrent: true,
            hasRetry: this.pathError.length > 0,
            onBack: () => {
              this.choosePath = false;
            },
            onParent: () => {
              const parent: string | null = this.parentPath();
              if (parent !== null) {
                void this.loadDirectory(parent, false);
              }
            },
            onUseCurrent: () => {
              if (this.canUseCurrentPath()) {
                this.selectedWorkspacePath = this.currentPath;
                this.currentPath = this.selectedWorkspacePath;
                this.projectCreateError = '';
              }
            },
            onRetry: () => {
              void this.loadDirectory(this.retryDirectoryPath, false);
            },
            onOpenEntry: (entry: NewSessionPathEntry) => {
              void this.loadDirectory(entry.path, false);
            },
          })
            .layoutWeight(1)
        } else {
          NewSessionWorkspaceSection({
            colors: this.colors,
            path: this.selectedWorkspacePath,
            connectorId: this.selectedDeviceId,
            deviceOs: this.selectedDeviceOs(),
            homePath: this.homePath.length > 0 ? this.homePath : null,
            projectMode: this.sidebarViewMode !== SIDEBAR_VIEW_SESSION,
            projects: this.projectsList(),
            sessions: this.state.sessions.concat(this.state.archivedSessions),
            canCreateProject: this.onlineDevices().length > 0,
            onSelect: (choice: WorkspaceChoice) => {
              this.selectedWorkspacePath = choice.path;
              this.currentPath = choice.path;
            },
            onCreate: () => this.beginProjectCreation(),
            onBrowse: () => {
              this.choosePath = true;
              const home: string = this.homePath.length > 0 ? this.homePath : '~';
              void this.loadDirectory(home === '~' ? '.' : home, false);
            },
          })
            .layoutWeight(1)
        }
      }
      .width('100%')
      .layoutWeight(1)
      .padding({ left: 18, right: 18, top: 12 })
      .alignItems(HorizontalAlign.Start)

      Column({ space: 10 }) {
        if (this.runtimeError().length > 0) {
          Row({ space: 10 }) {
            Text(this.runtimeError())
              .fontSize(13)
              .lineHeight(17)
              .fontWeight(600)
              .fontColor(this.colors.errorText)
              .layoutWeight(1)

            if (this.onlineDevices().length > 0) {
              Text($r('app.string.common_retry'))
                .fontSize(13)
                .fontWeight(FontWeight.Bold)
                .fontColor(this.colors.primaryAction)
                .onClick(() => {
                  if (this.selection.runtimesErrorMessage !== null
                    || this.selection.runtimes.length === 0) {
                    this.inventory.refresh();
                    this.startInventory();
                  } else {
                    this.loadRuntimeDetails();
                  }
                })
            }
          }
          .width('100%')
          .padding({ left: 4, right: 4 })
          .alignItems(VerticalAlign.Center)
        }

        StartChatButton({
          colors: this.colors,
          label: $r('app.string.new_session_start_chat'),
          buttonEnabled: this.canStart(),
          onTap: () => this.startSession(),
        })
      }
      .width('100%')
      .padding({ left: 18, right: 18, bottom: 10 })
    }
  }

  /** The project editor's directory browser: Android's `ChoosePathSection`. */
  @Builder
  ProjectDirectorySection() {
    NewSessionPathSection({
      colors: this.colors,
      currentPath: this.currentPath,
      currentPathLabel: this.pathLabel(),
      parentPath: this.parentPath(),
      entries: this.pathEntries,
      loading: this.pathLoading,
      errorMessage: this.pathError,
      canUseCurrent: this.directoryReady(),
      sectionEnabled: this.selectedDevice() !== null && !this.projectCreating,
      collapsible: true,
      title: resolveString($r('app.string.new_session_project_directory')),
      hasBack: false,
      hasUseCurrent: false,
      hasRetry: this.pathError.length > 0,
      onParent: () => {
        const parent: string | null = this.parentPath();
        if (parent !== null) {
          this.browseDirectory(parent);
        }
      },
      onRetry: () => this.browseDirectory(this.retryDirectoryPath),
      onOpenEntry: (entry: NewSessionPathEntry) => this.browseDirectory(entry.path),
    })
      .layoutWeight(1)
  }

  /**
   * Android's workspace-conflict `AlertDialog`: the directory already belongs to
   * a project with another name, so the user chooses between renaming it and
   * giving up.
   */
  @Builder
  WorkspaceConflictDialog() {
    ProfileDialogFrame({
      colors: this.colors,
      title: $r('app.string.project_workspace_conflict_title'),
      onDismiss: () => {
        this.workspaceConflict = null;
      },
    }) {
      Column({ space: 14 }) {
        Text(this.workspaceConflictMessage())
          .fontSize(14)
          .lineHeight(20)
          .fontColor(this.colors.muted)
          .width('100%')

        Row({ space: 10 }) {
          ProfileDialogButton({
            colors: this.colors,
            label: $r('app.string.common_cancel'),
            onTap: () => {
              this.workspaceConflict = null;
            },
          })

          ProfileDialogButton({
            colors: this.colors,
            label: $r('app.string.project_rename_existing'),
            primary: true,
            onTap: () => {
              this.workspaceConflict = null;
              this.createProject(true);
            },
          })
        }
        .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  /** The conflict text, or an empty string when no conflict is showing. */
  private workspaceConflictMessage(): string {
    const conflict: AgentProject | null = this.workspaceConflict;
    if (conflict === null) {
      return '';
    }
    return resolveStringWith($r('app.string.project_workspace_conflict_message'), [conflict.name, this.projectName]);
  }

  /** Android's `configurationFields.first { it.key == Device }`. */
  private deviceField(): NewSessionConfigurationField {
    for (const field of this.configurationFields()) {
      if (field.key === NewSessionConfigurationKey.Device) {
        return field;
      }
    }
    return new NewSessionConfigurationField(
      NewSessionConfigurationKey.Device, '', '', '', [], false,
    );
  }

  /** The panel state, but only for the reasons that replace the whole page. */
  private setupPageState(): NewSessionSetupState | null {
    const setup: NewSessionSetupState | null = this.setupState();
    if (setup === null) {
      return null;
    }
    if (setup.reason === NewSessionSetupReason.CheckingDevices
      || setup.reason === NewSessionSetupReason.CheckingAgents) {
      return null;
    }
    return setup;
  }
}
