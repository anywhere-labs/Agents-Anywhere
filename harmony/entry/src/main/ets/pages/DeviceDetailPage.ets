import { ApiClient } from 'network';
import { DevicesApi, RemoteDevice, RemoteDeviceRuntime } from 'network';
import { RemoteSession } from 'network';
import { SessionsApi } from 'network';
import { SharedApiClient } from 'session';
import { AuthSessionStore } from 'session';
import { errorMessageFrom } from 'common';
import { ConfirmDialog } from 'session';
import { APP_IS_DARK_KEY, getColors } from 'common';
import { showToast } from 'common';

// Mirrors android DeviceDetailScreen: filter tabs for the sessions section.
const FILTER_ACTIVE: number = 0;
const FILTER_ARCHIVED: number = 1;
const FILTER_ALL: number = 2;
// Mirrors android DeviceConfirmAction variants.
const ACTION_NONE: number = 0;
const ACTION_DELETE_DEVICE: number = 1;
const ACTION_REVOKE_DEVICE: number = 2;
const ACTION_DELETE_RUNTIME: number = 3;
const ACTION_ARCHIVE_ALL: number = 4;

const DEVICE_SESSIONS_LIMIT: number = 100;

interface DeviceSessionItem {
  id: string;
  title: string;
  sortKey: string;
  updatedAtLabel: string;
  archived: boolean;
}

// Mirrors android SessionMappers.relativeTimeLabel.
function relativeTimeLabel(value: string | null): string {
  if (value === null || value.length === 0) {
    return '';
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return '';
  }
  const elapsedMs = Date.now() - parsed;
  if (elapsedMs < 60000) {
    return 'now';
  }
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return 'Yest.';
  }
  if (days < 7) {
    return `${days}d`;
  }
  if (days < 365) {
    return `${Math.floor(days / 7)}w`;
  }
  return `${Math.floor(days / 365)}y`;
}

// Mirrors android RuntimeIdentity.runtimeTypeLabel.
function runtimeTypeLabel(runtimeType: string): string {
  if (runtimeType === 'codex') {
    return 'Codex';
  }
  if (runtimeType === 'claude') {
    return 'Claude Code';
  }
  if (runtimeType === 'dsh') {
    return 'DeepSeek Harness';
  }
  if (runtimeType.length === 0) {
    return runtimeType;
  }
  return runtimeType.charAt(0).toUpperCase() + runtimeType.substring(1);
}

function runtimePrimaryLabel(runtime: RemoteDeviceRuntime): string {
  const typeLabel = runtimeTypeLabel(runtime.runtimeType);
  const instanceName = runtime.displayName.trim();
  if (instanceName.length > 0 && instanceName.toLowerCase() !== runtime.runtimeType.toLowerCase()) {
    return instanceName;
  }
  return typeLabel;
}

function runtimeSecondaryLabel(runtime: RemoteDeviceRuntime): string {
  const typeLabel = runtimeTypeLabel(runtime.runtimeType);
  const primary = runtimePrimaryLabel(runtime);
  if (typeLabel.toLowerCase() === primary.toLowerCase()) {
    return '';
  }
  return typeLabel;
}

// Mirrors android deviceRuntimeComparator: codex < claude < dsh < others.
function runtimeTypeOrder(runtime: RemoteDeviceRuntime): number {
  if (runtime.runtimeType === 'codex') {
    return 0;
  }
  if (runtime.runtimeType === 'claude') {
    return 1;
  }
  if (runtime.runtimeType === 'dsh') {
    return 2;
  }
  return 99;
}

// Mirrors android SessionMappers.toAgentSession title/activity mapping.
function sessionItemFrom(session: RemoteSession): DeviceSessionItem {
  let title = session.title ?? '';
  if (title.trim().length === 0) {
    title = session.externalSessionId ?? '';
  }
  if (title.trim().length === 0) {
    title = 'Untitled session';
  }
  const activityAt = session.sortAt ?? session.lastActivityAt ?? session.lastItemAt ??
    session.lastSyncedAt ?? session.sourceObservedAt;
  const item: DeviceSessionItem = {
    id: session.id,
    title: title,
    sortKey: session.sortAt ?? session.lastActivityAt ?? session.lastItemAt ?? '',
    updatedAtLabel: relativeTimeLabel(activityAt),
    archived: session.archived
  };
  return item;
}

@Component
export struct DeviceDetailPage {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @State deviceId: string = '';
  @State device: RemoteDevice | null = null;
  @State deviceMissing: boolean = false;
  @State runtimesLoading: boolean = true;
  @State runtimes: RemoteDeviceRuntime[] = [];
  @State runtimesError: string = '';
  @State pendingRuntimeId: string = '';
  @State activeSessions: DeviceSessionItem[] = [];
  @State archivedSessions: DeviceSessionItem[] = [];
  @State sessionsFilter: number = FILTER_ACTIVE;
  @State selectMode: boolean = false;
  @State selectedIds: string[] = [];
  @State bulkBusy: boolean = false;
  @State bulkMessage: string = '';
  @State actionError: string = '';
  @State actionsSheetOpen: boolean = false;
  @State renaming: boolean = false;
  @State renameInput: string = '';
  @State renameBusy: boolean = false;
  @State renameError: string = '';
  @State confirmAction: number = ACTION_NONE;
  @State actionBusy: boolean = false;
  private pendingDeleteRuntime: RemoteDeviceRuntime | null = null;
  private pendingArchiveArchived: boolean = true;
  private pendingArchiveScope: string = 'active';
  private navPathStack: NavPathStack = new NavPathStack();
  private authStore: AuthSessionStore = AuthSessionStore.getInstance();
  private client: ApiClient = SharedApiClient.getInstance();
  private devicesApi: DevicesApi = new DevicesApi(this.client);
  private sessionsApi: SessionsApi = new SessionsApi(this.client);
  private runtimesRequestSeq: number = 0;
  private sessionsRequestSeq: number = 0;
  private shownOnce: boolean = false;
  private confirmDialog: CustomDialogController = new CustomDialogController({
    builder: ConfirmDialog({
      title: this.confirmTitleText(),
      message: this.confirmMessageText(),
      confirmText: this.confirmLabelText(),
      cancelText: $r('app.string.common_cancel'),
      confirmIsDanger: this.confirmAction === ACTION_DELETE_DEVICE ||
        this.confirmAction === ACTION_REVOKE_DEVICE ||
        this.confirmAction === ACTION_DELETE_RUNTIME,
      onConfirm: (): void => {
        this.confirmDialog.close();
        this.runConfirmAction();
      },
      onCancel: (): void => {
        this.confirmDialog.close();
      }
    }),
    autoCancel: true,
    alignment: DialogAlignment.Center
  });

  private serverUrl(): string {
    return this.authStore.readServerUrl();
  }

  private token(): string {
    return this.authStore.readAccessToken();
  }

  private localized(resource: Resource): string {
    return getContext(this).resourceManager.getStringSync(resource);
  }

  // getStringSync does not substitute $r format params, so replace the
  // "%d" placeholder manually.
  private localizedWithCount(resource: Resource, count: number): string {
    return this.localized(resource).replace('%d', count.toString());
  }

  private deviceNameText(): string {
    return this.device !== null ? this.device.name : '';
  }

  private deviceOnline(): boolean {
    return this.device !== null && this.device.status === 'online';
  }

  private statusLabelColor(): string {
    return this.deviceOnline() ? '#10B981' : getColors().muted;
  }

  private configuredRuntimes(): RemoteDeviceRuntime[] {
    const configured: RemoteDeviceRuntime[] = [];
    for (const runtime of this.runtimes) {
      if (runtime.configured) {
        configured.push(runtime);
      }
    }
    configured.sort((left: RemoteDeviceRuntime, right: RemoteDeviceRuntime): number => {
      const leftOrder = runtimeTypeOrder(left);
      const rightOrder = runtimeTypeOrder(right);
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      const leftName = left.displayName.toLowerCase();
      const rightName = right.displayName.toLowerCase();
      if (leftName !== rightName) {
        return leftName < rightName ? -1 : 1;
      }
      return 0;
    });
    return configured;
  }

  private isLastConfiguredRuntime(runtime: RemoteDeviceRuntime): boolean {
    const configured = this.configuredRuntimes();
    return configured.length === 0 || configured[configured.length - 1].runtimeId === runtime.runtimeId;
  }

  // Mirrors android DeviceDetailScreen.runtimeStatusLabel.
  private runtimeStatusLabel(runtime: RemoteDeviceRuntime): string {
    if (!runtime.present) {
      return this.localized($r('app.string.device_runtime_not_present'));
    }
    if (!runtime.configured) {
      return this.localized($r('app.string.device_runtime_not_configured'));
    }
    if (runtime.status === 'stopped') {
      return this.localized($r('app.string.device_runtime_stopped'));
    }
    if (runtime.status === 'discovering') {
      return this.localized($r('app.string.device_runtime_discovering'));
    }
    if (runtime.status === 'available') {
      return this.localized($r('app.string.device_runtime_available'));
    }
    if (runtime.status === 'unavailable') {
      return this.localized($r('app.string.device_runtime_unavailable'));
    }
    if (runtime.status === 'validating') {
      return this.localized($r('app.string.device_runtime_validating'));
    }
    if (runtime.status === 'starting') {
      return this.localized($r('app.string.device_runtime_starting'));
    }
    if (runtime.status === 'running') {
      return this.localized($r('app.string.device_runtime_running'));
    }
    if (runtime.status === 'stopping') {
      return this.localized($r('app.string.device_runtime_stopping'));
    }
    if (runtime.status === 'error') {
      return this.localized($r('app.string.device_runtime_error'));
    }
    return this.localized($r('app.string.device_runtime_unknown'));
  }

  private runtimeSecondaryText(runtime: RemoteDeviceRuntime): string {
    const secondary = runtimeSecondaryLabel(runtime);
    const status = this.runtimeStatusLabel(runtime);
    if (secondary.length > 0) {
      return `${secondary} · ${status}`;
    }
    return status;
  }

  private runtimeIndicatorColor(runtime: RemoteDeviceRuntime): string {
    if (runtime.status === 'running') {
      return getColors().runtimeRunning;
    }
    if (runtime.status === 'error') {
      return getColors().errorIcon;
    }
    if (runtime.status === 'starting' || runtime.status === 'stopping') {
      return getColors().runtimeTransitioning;
    }
    if (runtime.active) {
      return getColors().runtimeActive;
    }
    return getColors().runtimeInactive;
  }

  // Mirrors android ConfiguredAgentRow switch enablement.
  private runtimeSwitchEnabled(runtime: RemoteDeviceRuntime): boolean {
    if (this.pendingRuntimeId.length > 0) {
      return false;
    }
    return runtime.active || (runtime.present && runtime.configured);
  }

  private runtimeDeleteEnabled(runtime: RemoteDeviceRuntime): boolean {
    return this.pendingRuntimeId.length === 0 && runtime.configured;
  }

  private visibleSessions(): DeviceSessionItem[] {
    if (this.sessionsFilter === FILTER_ACTIVE) {
      return this.activeSessions;
    }
    if (this.sessionsFilter === FILTER_ARCHIVED) {
      return this.archivedSessions;
    }
    const merged: DeviceSessionItem[] = this.activeSessions.concat(this.archivedSessions);
    merged.sort((left: DeviceSessionItem, right: DeviceSessionItem): number => {
      if (left.sortKey !== right.sortKey) {
        return left.sortKey > right.sortKey ? -1 : 1;
      }
      return 0;
    });
    return merged;
  }

  private isLastVisibleSession(item: DeviceSessionItem): boolean {
    const visible = this.visibleSessions();
    return visible.length === 0 || visible[visible.length - 1].id === item.id;
  }

  private isSelected(id: string): boolean {
    return this.selectedIds.indexOf(id) >= 0;
  }

  private selectedCount(): number {
    let count = 0;
    for (const item of this.visibleSessions()) {
      if (this.isSelected(item.id)) {
        count++;
      }
    }
    return count;
  }

  private allSelected(): boolean {
    const visible = this.visibleSessions();
    if (visible.length === 0) {
      return false;
    }
    for (const item of visible) {
      if (!this.isSelected(item.id)) {
        return false;
      }
    }
    return true;
  }

  // Mirrors android targetArchivedForSelection.
  private targetArchivedForSelection(): boolean {
    if (this.sessionsFilter === FILTER_ARCHIVED) {
      return false;
    }
    if (this.sessionsFilter === FILTER_ACTIVE) {
      return true;
    }
    for (const item of this.visibleSessions()) {
      if (this.isSelected(item.id) && !item.archived) {
        return true;
      }
    }
    return false;
  }

  private bulkActionLabel(): ResourceStr {
    if (this.targetArchivedForSelection()) {
      return $r('app.string.device_detail_archive_selected');
    }
    return $r('app.string.device_detail_unarchive_selected');
  }

  private emptySessionsText(): string {
    if (this.sessionsFilter === FILTER_ACTIVE) {
      return this.localized($r('app.string.device_detail_no_active_sessions'));
    }
    if (this.sessionsFilter === FILTER_ARCHIVED) {
      return this.localized($r('app.string.device_detail_no_archived_sessions'));
    }
    return this.localized($r('app.string.device_detail_no_sessions'));
  }

  private sessionTimeLabel(item: DeviceSessionItem): string {
    if (item.updatedAtLabel.length > 0) {
      return item.updatedAtLabel;
    }
    return this.localized($r('app.string.common_now'));
  }

  private archiveScope(): string {
    if (this.sessionsFilter === FILTER_ACTIVE) {
      return 'active';
    }
    if (this.sessionsFilter === FILTER_ARCHIVED) {
      return 'archived';
    }
    return 'all';
  }

  private archiveScopeLabelText(): string {
    if (this.pendingArchiveScope === 'archived') {
      return this.localized($r('app.string.device_detail_all_archived_sessions'));
    }
    if (this.pendingArchiveScope === 'all') {
      return this.localized($r('app.string.device_detail_all_sessions'));
    }
    return this.localized($r('app.string.device_detail_all_active_sessions'));
  }

  private pendingRuntimeLabel(): string {
    const runtime = this.pendingDeleteRuntime;
    if (runtime === null) {
      return '';
    }
    return runtimePrimaryLabel(runtime);
  }

  // --- Confirm dialog texts (read when the dialog opens) --------------------

  private confirmTitleText(): ResourceStr {
    if (this.confirmAction === ACTION_DELETE_DEVICE) {
      return $r('app.string.device_confirm_delete_device_title');
    }
    if (this.confirmAction === ACTION_REVOKE_DEVICE) {
      return $r('app.string.device_confirm_revoke_title');
    }
    if (this.confirmAction === ACTION_DELETE_RUNTIME) {
      return $r('app.string.devices_runtime_delete_title', this.pendingRuntimeLabel());
    }
    if (this.confirmAction === ACTION_ARCHIVE_ALL) {
      if (this.pendingArchiveArchived) {
        return $r('app.string.device_confirm_archive_all_title', this.archiveScopeLabelText());
      }
      return $r('app.string.device_confirm_unarchive_all_title', this.archiveScopeLabelText());
    }
    return '';
  }

  private confirmMessageText(): ResourceStr {
    if (this.confirmAction === ACTION_DELETE_DEVICE) {
      return $r('app.string.device_confirm_delete_device_body');
    }
    if (this.confirmAction === ACTION_REVOKE_DEVICE) {
      return $r('app.string.device_confirm_revoke_body', this.deviceNameText());
    }
    if (this.confirmAction === ACTION_DELETE_RUNTIME) {
      const runtime = this.pendingDeleteRuntime;
      if (runtime !== null && runtime.active) {
        return $r('app.string.devices_runtime_delete_active_body', this.pendingRuntimeLabel());
      }
      return $r('app.string.devices_runtime_delete_body', this.pendingRuntimeLabel());
    }
    if (this.confirmAction === ACTION_ARCHIVE_ALL) {
      if (this.pendingArchiveArchived) {
        return $r('app.string.device_confirm_archive_all_body', this.deviceNameText());
      }
      return $r('app.string.device_confirm_unarchive_all_body', this.deviceNameText());
    }
    return '';
  }

  private confirmLabelText(): ResourceStr {
    if (this.confirmAction === ACTION_DELETE_DEVICE) {
      return $r('app.string.common_delete');
    }
    if (this.confirmAction === ACTION_REVOKE_DEVICE) {
      return $r('app.string.common_revoke');
    }
    if (this.confirmAction === ACTION_DELETE_RUNTIME) {
      return $r('app.string.devices_runtime_delete_confirm');
    }
    if (this.confirmAction === ACTION_ARCHIVE_ALL) {
      if (this.pendingArchiveArchived) {
        return $r('app.string.device_confirm_archive_all_confirm');
      }
      return $r('app.string.device_confirm_unarchive_all_confirm');
    }
    return '';
  }

  // --- Data loading ---------------------------------------------------------

  private async loadAll(): Promise<void> {
    this.loadDevice();
    this.loadRuntimes();
    this.reloadSessions();
  }

  private async loadDevice(): Promise<void> {
    if (this.deviceId.length === 0) {
      this.deviceMissing = true;
      return;
    }
    try {
      this.device = await this.devicesApi.getDevice(this.serverUrl(), this.token(), this.deviceId);
      this.deviceMissing = false;
    } catch (error) {
      this.deviceMissing = true;
    }
  }

  private async loadRuntimes(): Promise<void> {
    if (this.deviceId.length === 0) {
      return;
    }
    this.runtimesRequestSeq++;
    const seq = this.runtimesRequestSeq;
    this.runtimesLoading = true;
    try {
      const list = await this.devicesApi.listDeviceRuntimes(this.serverUrl(), this.token(), this.deviceId);
      if (this.runtimesRequestSeq !== seq) {
        return;
      }
      this.runtimes = list.runtimes;
      this.runtimesLoading = false;
      this.runtimesError = '';
    } catch (error) {
      if (this.runtimesRequestSeq !== seq) {
        return;
      }
      this.runtimesLoading = false;
      this.runtimesError = this.localized($r('app.string.device_runtime_load_failed'));
    }
  }

  private async reloadSessions(): Promise<void> {
    if (this.deviceId.length === 0) {
      return;
    }
    this.sessionsRequestSeq++;
    const seq = this.sessionsRequestSeq;
    try {
      const activePage = await this.sessionsApi.listSessions(this.serverUrl(), this.token(),
        false, DEVICE_SESSIONS_LIMIT, null);
      if (this.sessionsRequestSeq !== seq) {
        return;
      }
      const archivedPage = await this.sessionsApi.listSessions(this.serverUrl(), this.token(),
        true, DEVICE_SESSIONS_LIMIT, null);
      if (this.sessionsRequestSeq !== seq) {
        return;
      }
      const active: DeviceSessionItem[] = [];
      for (const session of activePage.sessions) {
        if (session.connectorId === this.deviceId) {
          active.push(sessionItemFrom(session));
        }
      }
      const archived: DeviceSessionItem[] = [];
      for (const session of archivedPage.sessions) {
        if (session.connectorId === this.deviceId) {
          archived.push(sessionItemFrom(session));
        }
      }
      this.activeSessions = active;
      this.archivedSessions = archived;
    } catch (error) {
      // Keep the last good session snapshot; a refresh will retry.
    }
  }

  // --- Actions ---------------------------------------------------------------

  private openActionsSheet(): void {
    this.renameInput = this.deviceNameText();
    this.renaming = false;
    this.renameError = '';
    this.actionsSheetOpen = true;
  }

  private closeActionsSheet(): void {
    if (this.renameBusy) {
      return;
    }
    this.actionsSheetOpen = false;
    this.renaming = false;
    this.renameError = '';
  }

  private beginRename(): void {
    this.renameInput = this.deviceNameText();
    this.renaming = true;
    this.renameError = '';
  }

  private cancelRename(): void {
    if (this.renameBusy) {
      return;
    }
    this.renaming = false;
    this.renameInput = this.deviceNameText();
    this.renameError = '';
  }

  private async submitRename(): Promise<void> {
    if (this.renameBusy) {
      return;
    }
    const next = this.renameInput.trim();
    if (next.length === 0 || next === this.deviceNameText()) {
      this.renaming = false;
      this.renameError = '';
      return;
    }
    this.renameBusy = true;
    this.renameError = '';
    try {
      const updated = await this.devicesApi.updateDevice(this.serverUrl(), this.token(),
        this.deviceId, next);
      this.device = updated;
      this.actionsSheetOpen = false;
      this.renaming = false;
    } catch (error) {
      this.renameError = errorMessageFrom(error as Object);
    }
    this.renameBusy = false;
  }

  private revokeFromSheet(): void {
    this.actionsSheetOpen = false;
    this.actionError = '';
    this.confirmAction = ACTION_REVOKE_DEVICE;
    this.confirmDialog.open();
  }

  private deleteFromSheet(): void {
    this.actionsSheetOpen = false;
    this.actionError = '';
    this.confirmAction = ACTION_DELETE_DEVICE;
    this.confirmDialog.open();
  }

  private requestDeleteRuntime(runtime: RemoteDeviceRuntime): void {
    if (!this.runtimeDeleteEnabled(runtime)) {
      return;
    }
    this.pendingDeleteRuntime = runtime;
    this.actionError = '';
    this.confirmAction = ACTION_DELETE_RUNTIME;
    this.confirmDialog.open();
  }

  private requestArchiveAll(): void {
    const visible = this.visibleSessions();
    if (visible.length === 0 || this.bulkBusy) {
      return;
    }
    this.pendingArchiveArchived = this.sessionsFilter !== FILTER_ARCHIVED;
    this.pendingArchiveScope = this.archiveScope();
    this.actionError = '';
    this.confirmAction = ACTION_ARCHIVE_ALL;
    this.confirmDialog.open();
  }

  private async runConfirmAction(): Promise<void> {
    if (this.actionBusy) {
      return;
    }
    const action = this.confirmAction;
    this.actionBusy = true;
    try {
      if (action === ACTION_DELETE_DEVICE) {
        await this.devicesApi.deleteDevice(this.serverUrl(), this.token(), this.deviceId);
        this.confirmAction = ACTION_NONE;
        this.actionError = '';
        this.navPathStack.pop();
      } else if (action === ACTION_REVOKE_DEVICE) {
        await this.devicesApi.revokeDevice(this.serverUrl(), this.token(), this.deviceId);
        this.confirmAction = ACTION_NONE;
        this.actionError = '';
        await this.loadDevice();
      } else if (action === ACTION_DELETE_RUNTIME) {
        const runtime = this.pendingDeleteRuntime;
        if (runtime !== null) {
          await this.devicesApi.deleteDeviceRuntimeConfig(this.serverUrl(), this.token(),
            runtime.connectorId, runtime.runtimeId);
          this.pendingDeleteRuntime = null;
          this.confirmAction = ACTION_NONE;
          await this.loadRuntimes();
        }
      } else if (action === ACTION_ARCHIVE_ALL) {
        const sessions = await this.sessionsApi.archiveAllDeviceSessions(this.serverUrl(), this.token(),
          this.deviceId, this.pendingArchiveArchived, this.pendingArchiveScope);
        this.confirmAction = ACTION_NONE;
        this.selectMode = false;
        this.selectedIds = [];
        this.bulkMessage = '';
        this.actionError = '';
        if (this.pendingArchiveArchived) {
          showToast($r('app.string.device_detail_archived_sessions_toast', sessions.length));
        } else {
          showToast($r('app.string.device_detail_unarchived_sessions_toast', sessions.length));
        }
        await this.reloadSessions();
      }
    } catch (error) {
      this.actionError = errorMessageFrom(error as Object);
      showToast(this.actionError);
    }
    this.actionBusy = false;
  }

  private async setRuntimeActive(runtime: RemoteDeviceRuntime, active: boolean): Promise<void> {
    if (this.pendingRuntimeId.length > 0) {
      return;
    }
    this.pendingRuntimeId = runtime.runtimeId;
    try {
      await this.devicesApi.setDeviceRuntimeActive(this.serverUrl(), this.token(),
        runtime.connectorId, runtime.runtimeId, active);
      this.pendingRuntimeId = '';
      await this.loadRuntimes();
    } catch (error) {
      this.pendingRuntimeId = '';
      await this.loadRuntimes();
      this.runtimesError = this.localized($r('app.string.devices_runtime_update_failed'));
    }
  }

  private onSwitchClick(runtime: RemoteDeviceRuntime): void {
    if (!this.runtimeSwitchEnabled(runtime) || this.pendingRuntimeId.length > 0) {
      return;
    }
    this.setRuntimeActive(runtime, !runtime.active);
  }

  // --- Sessions selection / bulk --------------------------------------------

  private toggleSelectMode(): void {
    this.selectMode = !this.selectMode;
    this.selectedIds = [];
    this.bulkMessage = '';
  }

  private selectFilter(filter: number): void {
    this.sessionsFilter = filter;
    this.selectedIds = [];
    this.bulkMessage = '';
  }

  private toggleSession(id: string): void {
    if (this.isSelected(id)) {
      const next: string[] = [];
      for (const existing of this.selectedIds) {
        if (existing !== id) {
          next.push(existing);
        }
      }
      this.selectedIds = next;
    } else {
      const next = this.selectedIds.slice();
      next.push(id);
      this.selectedIds = next;
    }
  }

  private toggleSelectAll(): void {
    const visible = this.visibleSessions();
    if (visible.length === 0) {
      return;
    }
    if (this.allSelected()) {
      this.selectedIds = [];
    } else {
      const next: string[] = [];
      for (const item of visible) {
        next.push(item.id);
      }
      this.selectedIds = next;
    }
  }

  private onSessionClick(item: DeviceSessionItem): void {
    if (this.selectMode) {
      this.toggleSession(item.id);
    } else {
      this.navPathStack.pushPathByName('session_detail', item.id);
    }
  }

  private async bulkArchiveSelected(): Promise<void> {
    if (this.bulkBusy || this.selectedIds.length === 0) {
      return;
    }
    const targetArchived = this.targetArchivedForSelection();
    const ids = this.selectedIds.slice();
    this.bulkBusy = true;
    this.bulkMessage = '';
    try {
      if (targetArchived) {
        const update = await this.sessionsApi.archiveSessions(this.serverUrl(), this.token(), ids);
        this.selectMode = false;
        this.selectedIds = [];
        if (update.notFound.length > 0) {
          this.bulkMessage = this.localizedWithCount(
            $r('app.string.device_detail_sessions_not_found'), update.notFound.length);
        }
        showToast($r('app.string.device_detail_archived_sessions_toast', update.sessions.length));
      } else {
        const update = await this.sessionsApi.unarchiveSessions(this.serverUrl(), this.token(), ids);
        this.selectMode = false;
        this.selectedIds = [];
        if (update.notFound.length > 0) {
          this.bulkMessage = this.localizedWithCount(
            $r('app.string.device_detail_sessions_not_found'), update.notFound.length);
        }
        showToast($r('app.string.device_detail_unarchived_sessions_toast', update.sessions.length));
      }
      await this.reloadSessions();
    } catch (error) {
      this.bulkMessage = errorMessageFrom(error as Object);
    }
    this.bulkBusy = false;
  }

  // --- Builders ---------------------------------------------------------------

  @Builder
  detailHeader() {
    Row({ space: 8 }) {
      Row() {
        SymbolGlyph($r('sys.symbol.chevron_left'))
          .fontSize(16)
          .fontColor([getColors().ink])
      }
      .width(38)
      .height(38)
      .borderRadius(19)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .backgroundColor(this.themeIsDark ? getColors().subtle : '#FFFFFF')
      .border({ width: 1, color: getColors().border })
      .onClick(() => {
        this.navPathStack.pop();
      })

      Row({ space: 9 }) {
        Text(this.deviceNameText())
          .fontSize(25)
          .fontWeight(800)
          .lineHeight(29)
          .fontColor(getColors().ink)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .flexShrink(1)
        Row({ space: 6 }) {
          SymbolGlyph(this.deviceOnline() ? $r('sys.symbol.checkmark_circle') : $r('sys.symbol.circle'))
            .fontSize(16)
            .fontColor([this.statusLabelColor()])
            .opacity(this.deviceOnline() ? 1 : 0.4)
          Text(this.deviceOnline() ? $r('app.string.devices_online') : $r('app.string.devices_offline'))
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .lineHeight(16)
            .fontColor(this.statusLabelColor())
            .maxLines(1)
        }
        .alignItems(VerticalAlign.Center)
      }
      .layoutWeight(1)
      .height('100%')
      .alignItems(VerticalAlign.Center)

      Row({ space: 3.5 }) {
        Circle()
          .width(4)
          .height(4)
          .fill(getColors().ink)
        Circle()
          .width(4)
          .height(4)
          .fill(getColors().ink)
        Circle()
          .width(4)
          .height(4)
          .fill(getColors().ink)
      }
      .width(38)
      .height(38)
      .borderRadius(19)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .backgroundColor(this.themeIsDark ? getColors().subtle : '#FFFFFF')
      .border({ width: 1, color: getColors().border })
      .onClick(() => {
        this.openActionsSheet();
      })
    }
    .width('100%')
    .height(64)
    .padding({ left: 24, right: 24 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  missingDeviceView() {
    Column({ space: 8 }) {
      Text($r('app.string.device_detail_not_found'))
        .fontSize(24)
        .fontWeight(800)
        .fontColor(getColors().ink)
      Text($r('app.string.device_detail_refresh_try_again'))
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(getColors().muted)
    }
    .width('100%')
    .padding({ top: 120 })
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  runtimeStatusIndicator(runtime: RemoteDeviceRuntime) {
    Stack() {
      if (this.pendingRuntimeId === runtime.runtimeId) {
        LoadingProgress()
          .width(14)
          .height(14)
      } else {
        Circle()
          .width(8)
          .height(8)
          .fill(this.runtimeIndicatorColor(runtime))
      }
    }
    .width(14)
    .height(14)
    .alignContent(Alignment.Center)
  }

  @Builder
  webRuntimeSwitch(runtime: RemoteDeviceRuntime) {
    Row() {
      Circle()
        .width(16)
        .height(16)
        .fill(runtime.active ? getColors().runtimeSwitchCheckedThumb : getColors().runtimeSwitchUncheckedThumb)
    }
    .width(32)
    .height(20)
    .padding(2)
    .borderRadius(10)
    .justifyContent(runtime.active ? FlexAlign.End : FlexAlign.Start)
    .backgroundColor(runtime.active ? getColors().runtimeSwitchCheckedTrack : getColors().runtimeSwitchUncheckedTrack)
    .border({ width: 2, color: runtime.active ? getColors().runtimeSwitchCheckedTrack : '#00000000' })
    .opacity(this.runtimeSwitchEnabled(runtime) ? 1 : 0.5)
    .onClick(() => {
      this.onSwitchClick(runtime);
    })
  }

  @Builder
  configuredAgentRow(runtime: RemoteDeviceRuntime) {
    Column() {
      Row({ space: 12 }) {
        this.runtimeStatusIndicator(runtime)
        Column({ space: 2 }) {
          Text(runtimePrimaryLabel(runtime))
            .fontSize(16.5)
            .fontWeight(FontWeight.Bold)
            .fontColor(getColors().ink)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
          Text(this.runtimeSecondaryText(runtime))
            .fontSize(11.5)
            .fontWeight(FontWeight.Medium)
            .fontColor(runtime.status === 'error' ? getColors().errorText : getColors().muted)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        Row({ space: 8 }) {
          this.webRuntimeSwitch(runtime)
          Row() {
            SymbolGlyph($r('sys.symbol.trash'))
              .fontSize(16)
              .fontColor([getColors().muted])
          }
          .width(32)
          .height(32)
          .justifyContent(FlexAlign.Center)
          .alignItems(VerticalAlign.Center)
          .enabled(this.runtimeDeleteEnabled(runtime))
          .onClick(() => {
            this.requestDeleteRuntime(runtime);
          })
        }
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .constraintSize({ minHeight: 72 })
      .padding({ top: 5, bottom: 5 })
      .alignItems(VerticalAlign.Center)
      if (!this.isLastConfiguredRuntime(runtime)) {
        Divider()
          .width('100%')
          .strokeWidth(1)
          .color(getColors().border)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  desktopConfigurationHint() {
    Row({ space: 8 }) {
      SymbolGlyph($r('sys.symbol.exclamationmark_circle'))
        .fontSize(15)
        .fontColor([getColors().muted])
      Text($r('app.string.device_runtime_desktop_configuration_hint'))
        .fontSize(12.5)
        .fontWeight(FontWeight.Medium)
        .lineHeight(17)
        .fontColor(getColors().muted)
        .layoutWeight(1)
    }
    .width('100%')
    .padding({ top: 14, bottom: 2 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  retryButton() {
    Row({ space: 5 }) {
      SymbolGlyph($r('sys.symbol.arrow_clockwise'))
        .fontSize(15)
        .fontColor([getColors().ink])
      Text($r('app.string.common_retry'))
        .fontSize(14)
        .fontWeight(FontWeight.Bold)
        .fontColor(getColors().ink)
    }
    .height(34)
    .borderRadius(6)
    .padding({ left: 11, right: 11 })
    .alignItems(VerticalAlign.Center)
    .margin({ top: 10 })
    .backgroundColor(this.themeIsDark ? getColors().subtle : '#F4F4F2')
    .onClick(() => {
      this.loadRuntimes();
    })
  }

  @Builder
  agentsSection() {
    Column({ space: 4 }) {
      Row() {
        Text($r('app.string.device_detail_agents_section'))
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .fontColor(getColors().faint)
          .maxLines(1)
      }
      .width('100%')
      .height(34)
      .alignItems(VerticalAlign.Center)

      if (this.runtimesLoading && this.runtimes.length === 0) {
        Row({ space: 10 }) {
          LoadingProgress()
            .width(18)
            .height(18)
          Text($r('app.string.device_runtime_loading'))
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .lineHeight(17)
            .fontColor(getColors().muted)
        }
        .width('100%')
        .height(56)
        .alignItems(VerticalAlign.Center)
      } else {
        if (this.runtimesError.length > 0) {
          Text(this.runtimesError)
            .fontSize(12.5)
            .fontWeight(600)
            .lineHeight(17)
            .fontColor(getColors().errorText)
            .width('100%')
            .padding({ bottom: 8 })
        }
        if (this.configuredRuntimes().length === 0) {
          Text($r('app.string.device_runtime_no_configured'))
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .lineHeight(17)
            .fontColor(getColors().muted)
            .width('100%')
            .padding({ top: 14, bottom: 14 })
        } else {
          ForEach(this.configuredRuntimes(), (runtime: RemoteDeviceRuntime) => {
            this.configuredAgentRow(runtime)
          }, (runtime: RemoteDeviceRuntime) =>
            `${runtime.runtimeId}_${runtime.displayName}_${runtime.status}_${runtime.active ? 1 : 0}_${runtime.present ? 1 : 0}_${runtime.configured ? 1 : 0}_${this.pendingRuntimeId === runtime.runtimeId ? 1 : 0}`)
        }
        this.desktopConfigurationHint()
        if (this.runtimesError.length > 0) {
          this.retryButton()
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  // By-value params passed into a @Builder are frozen at first execution, so
  // state-derived values (enabled/selected/labels) must be read directly
  // inside the builder body instead of being passed as parameters.
  @Builder
  selectModeButton() {
    Row() {
      Text(this.selectMode ? $r('app.string.common_cancel') : $r('app.string.common_select'))
        .fontSize(12.5)
        .fontWeight(FontWeight.Bold)
        .maxLines(1)
        .fontColor(getColors().ink)
    }
    .height(30)
    .borderRadius(15)
    .padding({ left: 11, right: 11 })
    .justifyContent(FlexAlign.Center)
    .backgroundColor(this.miniSecondarySurface())
    .opacity(this.visibleSessions().length > 0 && !this.bulkBusy ? 1 : 0.45)
    .onClick(() => {
      if (this.visibleSessions().length > 0 && !this.bulkBusy) {
        this.toggleSelectMode();
      }
    })
  }

  @Builder
  archiveAllButton() {
    Row() {
      Text(this.sessionsFilter === FILTER_ARCHIVED ?
        $r('app.string.device_detail_unarchive_all') : $r('app.string.device_detail_archive_all'))
        .fontSize(12.5)
        .fontWeight(FontWeight.Bold)
        .maxLines(1)
        .fontColor(getColors().ink)
    }
    .height(30)
    .borderRadius(15)
    .padding({ left: 11, right: 11 })
    .justifyContent(FlexAlign.Center)
    .backgroundColor(this.miniSecondarySurface())
    .opacity(this.visibleSessions().length > 0 && !this.bulkBusy ? 1 : 0.45)
    .onClick(() => {
      if (this.visibleSessions().length > 0 && !this.bulkBusy) {
        this.requestArchiveAll();
      }
    })
  }

  @Builder
  bulkActionButton() {
    Row() {
      Text(this.bulkBusy ? $r('app.string.common_working') : this.bulkActionLabel())
        .fontSize(12.5)
        .fontWeight(FontWeight.Bold)
        .maxLines(1)
        .fontColor(this.miniPrimaryContent())
    }
    .height(30)
    .borderRadius(15)
    .padding({ left: 11, right: 11 })
    .justifyContent(FlexAlign.Center)
    .backgroundColor(this.miniPrimarySurface())
    .opacity(this.selectedCount() > 0 && !this.bulkBusy ? 1 : 0.45)
    .onClick(() => {
      if (this.selectedCount() > 0 && !this.bulkBusy) {
        this.bulkArchiveSelected();
      }
    })
  }

  private miniPrimarySurface(): string {
    if (this.themeIsDark) {
      return '#E4E4E7';
    }
    return '#181816';
  }

  private miniPrimaryContent(): string {
    if (this.themeIsDark) {
      return '#181816';
    }
    return '#FFFFFF';
  }

  private miniSecondarySurface(): string {
    if (this.themeIsDark) {
      return getColors().subtle;
    }
    return '#ECECE9';
  }

  @Builder
  allSelectionCircle() {
    Stack() {
      if (this.allSelected()) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(13)
          .fontColor([this.selectionCheckColor()])
      }
    }
    .width(20)
    .height(20)
    .borderRadius(10)
    .backgroundColor(this.allSelected() ? this.selectionFillColor() : '#00000000')
    .border({ width: 1, color: this.allSelected() ? this.selectionFillColor() : getColors().border })
  }

  @Builder
  rowSelectionCircle(id: string) {
    Stack() {
      if (this.isSelected(id)) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(13)
          .fontColor([this.selectionCheckColor()])
      }
    }
    .width(20)
    .height(20)
    .borderRadius(10)
    .backgroundColor(this.isSelected(id) ? this.selectionFillColor() : '#00000000')
    .border({ width: 1, color: this.isSelected(id) ? this.selectionFillColor() : getColors().border })
  }

  private selectionFillColor(): string {
    if (this.themeIsDark) {
      return '#E4E4E7';
    }
    return '#181816';
  }

  private selectionCheckColor(): string {
    if (this.themeIsDark) {
      return '#181816';
    }
    return '#FFFFFF';
  }

  @Builder
  filterTag(label: ResourceStr, filter: number) {
    Row() {
      Text(label)
        .fontSize(14)
        .fontWeight(this.sessionsFilter === filter ? FontWeight.Bold : 600)
        .maxLines(1)
        .fontColor(this.sessionsFilter === filter ? getColors().ink : this.filterTagTextColor())
    }
    .height(34)
    .borderRadius(17)
    .padding({ left: 14, right: 14 })
    .justifyContent(FlexAlign.Center)
    .backgroundColor(this.sessionsFilter === filter ? this.filterTagSelectedSurface() : '#00000000')
    .onClick(() => {
      this.selectFilter(filter);
    })
  }

  private filterTagSelectedSurface(): string {
    if (this.themeIsDark) {
      return '#27272A';
    }
    return '#ECECE9';
  }

  private filterTagTextColor(): string {
    if (this.themeIsDark) {
      return '#A1A1AA';
    }
    return '#8A8A88';
  }

  @Builder
  sessionBulkBar() {
      Row({ space: 10 }) {
        Row({ space: 7 }) {
          this.allSelectionCircle()
          Text($r('app.string.common_all'))
            .fontSize(12.5)
            .fontWeight(FontWeight.Bold)
            .fontColor(getColors().muted)
        }
        .alignItems(VerticalAlign.Center)
        .onClick(() => {
          this.toggleSelectAll();
        })

        Text(this.localizedWithCount($r('app.string.device_detail_selected_count'), this.selectedCount()))
          .fontSize(11.5)
          .fontFamily('monospace')
          .fontWeight(600)
          .fontColor(getColors().faint)
          .maxLines(1)
          .layoutWeight(1)

        this.bulkActionButton()
      }
    .width('100%')
    .height(44)
    .borderRadius(8)
    .padding({ left: 10, right: 10 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.themeIsDark ? getColors().subtle : '#F6F6F4')
    .border({ width: 1, color: getColors().border })
    .margin({ bottom: 4 })
  }

  @Builder
  sessionRow(item: DeviceSessionItem) {
    Column() {
      Row({ space: 12 }) {
        if (this.selectMode) {
          this.rowSelectionCircle(item.id)
        }
        SymbolGlyph($r('sys.symbol.list_bullet'))
          .fontSize(14)
          .fontColor([getColors().faint])
        Text(item.title)
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .lineHeight(20)
          .fontColor(getColors().inkSoft)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(this.sessionTimeLabel(item))
          .fontSize(10.8)
          .fontFamily('monospace')
          .fontWeight(600)
          .fontColor(getColors().faint)
          .maxLines(1)
      }
      .width('100%')
      .height(52)
      .padding({ top: 4, bottom: 4 })
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.onSessionClick(item);
      })
      if (!this.isLastVisibleSession(item)) {
        Divider()
          .width('100%')
          .strokeWidth(1)
          .color(this.themeIsDark ? '#27272A' : '#E9E8E5')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  sessionsSection() {
    Column({ space: 4 }) {
      Row({ space: 8 }) {
        Text($r('app.string.device_detail_sessions_section'))
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .fontColor(getColors().faint)
          .maxLines(1)
          .layoutWeight(1)
        this.selectModeButton()
        if (!this.selectMode) {
          this.archiveAllButton()
        }
      }
      .width('100%')
      .height(34)
      .alignItems(VerticalAlign.Center)

      Row({ space: 18 }) {
        this.filterTag($r('app.string.home_tab_active'), FILTER_ACTIVE)
        this.filterTag($r('app.string.home_tab_archived'), FILTER_ARCHIVED)
        this.filterTag($r('app.string.common_all'), FILTER_ALL)
      }
      .width('100%')
      .height(44)
      .padding({ bottom: 8 })
      .alignItems(VerticalAlign.Center)

      if (this.selectMode) {
        this.sessionBulkBar()
      }
      if (this.bulkMessage.length > 0) {
        Text(this.bulkMessage)
          .fontSize(12.5)
          .fontWeight(600)
          .lineHeight(16)
          .fontColor(getColors().muted)
          .width('100%')
          .padding({ top: 2, bottom: 2 })
      }
      if (this.visibleSessions().length === 0) {
        Text(this.emptySessionsText())
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .lineHeight(17)
          .fontColor(getColors().muted)
          .width('100%')
          .padding({ top: 14, bottom: 14 })
      } else {
        ForEach(this.visibleSessions(), (item: DeviceSessionItem) => {
          this.sessionRow(item)
        }, (item: DeviceSessionItem) =>
          `${item.id}_${item.updatedAtLabel}_${this.selectMode ? 1 : 0}_${this.isSelected(item.id) ? 1 : 0}`)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  sheetTextButton(label: ResourceStr, enabled: boolean, primary: boolean, action: () => void) {
    Row() {
      Text(label)
        .fontSize(15)
        .fontWeight(FontWeight.Bold)
        .maxLines(1)
        .fontColor(primary ? this.sheetPrimaryContent() : getColors().ink)
    }
    .height(44)
    .constraintSize({ minWidth: 104 })
    .borderRadius(22)
    .padding({ left: 20, right: 20 })
    .justifyContent(FlexAlign.Center)
    .backgroundColor(primary ? this.sheetPrimarySurface() : this.sheetSecondarySurface())
    .border({ width: primary ? 0 : 1, color: getColors().border })
    .opacity(enabled ? 1 : 0.5)
    .onClick(() => {
      if (enabled) {
        action();
      }
    })
  }

  private sheetPrimarySurface(): string {
    if (this.themeIsDark) {
      return '#E4E4E7';
    }
    return '#181816';
  }

  private sheetPrimaryContent(): string {
    if (this.themeIsDark) {
      return '#181816';
    }
    return '#FFFFFF';
  }

  private sheetSecondarySurface(): string {
    if (this.themeIsDark) {
      return '#111113';
    }
    return '#F7F7F5';
  }

  @Builder
  sheetItem(icon: Resource, label: ResourceStr, danger: boolean, action: () => void) {
    Row({ space: 12 }) {
      SymbolGlyph(icon)
        .fontSize(20)
        .fontColor([danger ? getColors().errorText : getColors().ink])
      Text(label)
        .fontSize(15)
        .lineHeight(21)
        .fontWeight(FontWeight.Medium)
        .fontColor(danger ? getColors().errorText : getColors().ink)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
    }
    .width('100%')
    .constraintSize({ minHeight: 52 })
    .padding({ left: 12, right: 12, top: 12, bottom: 12 })
    .borderRadius(14)
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      action();
    })
  }

  @Builder
  actionsSheetOverlay() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(this.themeIsDark ? '#8F000000' : '#47000000')
        .onClick(() => {
          this.closeActionsSheet();
        })

      Column() {
        Stack() {
          Column()
            .width(36)
            .height(4)
            .borderRadius(2)
            .backgroundColor(this.themeIsDark ? '#3F3F46' : '#D8D6D0')
        }
        .width('100%')
        .height(12)
        .alignContent(Alignment.Center)
        .margin({ top: 12, bottom: 8 })

        Row() {
          Text(this.renaming ? $r('app.string.device_actions_rename_device') : this.deviceNameText())
            .fontSize(18)
            .lineHeight(24)
            .fontWeight(600)
            .fontColor(getColors().ink)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          Row() {
            SymbolGlyph($r('sys.symbol.xmark'))
              .fontSize(16)
              .fontColor([getColors().muted])
          }
          .width(32)
          .height(32)
          .justifyContent(FlexAlign.Center)
          .alignItems(VerticalAlign.Center)
          .onClick(() => {
            this.closeActionsSheet();
          })
        }
        .width('100%')
        .padding({ left: 24, right: 12, top: 8 })
        .alignItems(VerticalAlign.Center)

        Column({ space: 4 }) {
          if (this.renaming) {
            TextInput({ text: this.renameInput, placeholder: $r('app.string.devices_rename_placeholder') })
              .height(50)
              .width('100%')
              .borderRadius(12)
              .backgroundColor(getColors().subtle)
              .border({ width: 1, color: getColors().border })
              .padding({ left: 14, right: 14 })
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(getColors().ink)
              .caretColor(getColors().ink)
              .maxLength(255)
              .enabled(!this.renameBusy)
              .onChange((value: string) => {
                this.renameInput = value;
                this.renameError = '';
              })
            if (this.renameError.length > 0) {
              Text(this.renameError)
                .fontSize(13)
                .fontWeight(600)
                .lineHeight(17)
                .fontColor(getColors().errorText)
                .width('100%')
            }
            Row({ space: 10 }) {
              this.sheetTextButton($r('app.string.common_cancel'), !this.renameBusy, false, (): void => {
                this.cancelRename();
              })
              this.sheetTextButton(this.renameBusy ? $r('app.string.common_saving') : $r('app.string.common_save'),
                !this.renameBusy, true, (): void => {
                  this.submitRename();
                })
            }
            .width('100%')
            .justifyContent(FlexAlign.SpaceBetween)
            .padding({ top: 8 })
          } else {
            this.sheetItem($r('sys.symbol.pencil_line'), $r('app.string.device_actions_rename'), false, (): void => {
              this.beginRename();
            })
            if (this.deviceOnline()) {
              this.sheetItem($r('sys.symbol.key'), $r('app.string.common_revoke'), false, (): void => {
                this.revokeFromSheet();
              })
            }
            this.sheetItem($r('sys.symbol.trash'), $r('app.string.common_delete'), true, (): void => {
              this.deleteFromSheet();
            })
          }
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 8, bottom: 20 })
      }
      .width('100%')
      .borderRadius({ topLeft: 28, topRight: 28 })
      .backgroundColor(getColors().raisedSurface)
    }
    .width('100%')
    .height('100%')
    .alignContent(Alignment.Bottom)
  }

  build() {
    NavDestination() {
      Stack() {
        Column() {
          this.detailHeader()
          Scroll() {
            Column({ space: 18 }) {
              if (this.deviceMissing) {
                this.missingDeviceView()
              } else {
                if (this.actionError.length > 0) {
                  Text(this.actionError)
                    .fontSize(13)
                    .fontWeight(600)
                    .lineHeight(17)
                    .fontColor(getColors().errorText)
                    .width('100%')
                }
                this.agentsSection()
                this.sessionsSection()
              }
            }
            .width('100%')
            .padding({ left: 24, right: 24, top: 8, bottom: 28 })
            .alignItems(HorizontalAlign.Start)
          }
          .width('100%')
          .layoutWeight(1)
          .align(Alignment.Top)
          .scrollBar(BarState.Off)
          .edgeEffect(EdgeEffect.Spring)
        }
        .width('100%')
        .height('100%')

        if (this.actionsSheetOpen) {
          this.actionsSheetOverlay()
        }
      }
      .width('100%')
      .height('100%')
    }
    .hideTitleBar(true)
    .onReady((ctx: NavDestinationContext) => {
      this.navPathStack = ctx.pathStack;
      const raw = ctx.pathInfo.param as string;
      if (typeof raw === 'string') {
        this.deviceId = raw;
      }
      this.loadAll();
    })
    .onShown(() => {
      if (this.shownOnce) {
        this.loadAll();
      } else {
        this.shownOnce = true;
      }
    })
  }
}

@Builder
export function DeviceDetailPageBuilder() {
  DeviceDetailPage()
}
