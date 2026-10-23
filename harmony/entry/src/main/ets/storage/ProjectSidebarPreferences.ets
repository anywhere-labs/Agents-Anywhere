import { AAPreferenceNames, AAPreferenceStore } from './AAPreferences';
import { ProjectSessionStatusFilter } from '../feature/sessions/ProjectSessionsState';

/**
 * Per-account project sidebar state.
 *
 * Port of the `project_sidebar` SharedPreferences usage in
 * `HomeProjectPreferences.kt`.
 *
 * Everything is keyed on the `(serverUrl, userId)` pair so switching servers or
 * accounts does not carry one account's expanded projects into another's list.
 * The key shape matches Android's `["<url>","<userId>"]` JSON array, which keeps
 * the two clients comparable when debugging.
 */
export class ProjectSidebarPreferences {
  private readonly store: AAPreferenceStore;
  private readonly keyPrefix: string;

  constructor(serverUrl: string, userId: string) {
    this.store = new AAPreferenceStore(AAPreferenceNames.PROJECT_SIDEBAR);
    this.keyPrefix = `["${serverUrl}","${userId}"]`;
  }

  /** Project ids whose tree is expanded. */
  expandedProjectIds(): string[] {
    return this.store.getStringArray(`${this.keyPrefix}:ids`);
  }

  setExpandedProjectIds(ids: string[]): void {
    this.store.setStringArray(`${this.keyPrefix}:ids`, ids);
  }

  /** Whether the "Projects" section itself is expanded. */
  projectsSectionExpanded(): boolean {
    return this.store.getBoolean(`${this.keyPrefix}:section`, true);
  }

  setProjectsSectionExpanded(expanded: boolean): void {
    this.store.setBoolean(`${this.keyPrefix}:section`, expanded);
  }

  /** The project tree's session-status filter. */
  statusFilter(): ProjectSessionStatusFilter {
    const stored: string = this.store.getString(`${this.keyPrefix}:status`, 'active');
    if (stored === 'archived') {
      return ProjectSessionStatusFilter.Archived;
    }
    if (stored === 'all') {
      return ProjectSessionStatusFilter.All;
    }
    return ProjectSessionStatusFilter.Active;
  }

  setStatusFilter(filter: ProjectSessionStatusFilter): void {
    let value: string = 'active';
    if (filter === ProjectSessionStatusFilter.Archived) {
      value = 'archived';
    } else if (filter === ProjectSessionStatusFilter.All) {
      value = 'all';
    }
    this.store.setString(`${this.keyPrefix}:status`, value);
  }
}
