import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AgentProject, AgentSession } from '../../../model/AgentSession';
import {
  recentWorkspacePaths, workspacePathKey, workspaceProject, workspaceProjectName,
} from '../../../feature/sessions/NewSessionWorkspaces';
import { WorkspaceActionRow, WorkspaceOptionRow } from './NewSessionComponents';
import { resolveString } from '../../../common/AAResources';

/**
 * The workspace chooser.
 *
 * Port of `ui/screens/home/NewSessionWorkspaceSection.kt`.
 *
 * Two modes share one list. In directory mode the first row browses the file
 * system and the rest are the workspaces this device has been used with, newest
 * first; in project mode the first row creates a project and the rest are the
 * device's projects. Either way the home directory is offered unless a project
 * already owns it.
 */

/** A chosen workspace: a path, and the project that owns it when there is one. */
export class WorkspaceChoice {
  readonly path: string;
  readonly projectId: string | null;

  constructor(path: string, projectId: string | null = null) {
    this.path = path;
    this.projectId = projectId;
  }
}

@Component
export struct NewSessionWorkspaceSection {
  colors: AAColors = AA_LIGHT_COLORS;
  path: string = '';
  connectorId: string = '';
  deviceOs: string | null = null;
  homePath: string | null = null;
  projectMode: boolean = false;
  projects: AgentProject[] = [];
  sessions: AgentSession[] = [];
  /** Disables the create-project row while a project name is missing. */
  canCreateProject: boolean = false;
  onSelect: (choice: WorkspaceChoice) => void = () => {};
  onCreate: () => void = () => {};
  onBrowse: () => void = () => {};

  private availableProjects(): AgentProject[] {
    return this.projects.filter((project: AgentProject) => project.connectorId === this.connectorId);
  }

  private homeProject(): AgentProject | null {
    return workspaceProject(
      this.availableProjects(), this.connectorId, this.homePath ?? '', this.deviceOs,
    );
  }

  private recent(): string[] {
    if (this.projectMode) {
      return [];
    }
    return recentWorkspacePaths(
      this.connectorId, this.deviceOs, this.homePath, this.sessions, this.projects,
    );
  }

  private selectionKey(): string {
    return workspacePathKey(this.path, this.deviceOs);
  }

  build() {
    Column({ space: 12 }) {
      Text(this.projectMode ? $r('app.string.home_projects') : $r('app.string.new_session_workspace'))
        .fontSize(17)
        .fontWeight(600)
        .fontColor(this.colors.ink)

      List({ space: 4 }) {
        ListItem() {
          WorkspaceActionRow({
            colors: this.colors,
            title: this.projectMode
              ? $r('app.string.new_session_create_project') : $r('app.string.workspace_browse'),
            commands: AA_ICONS.PLUS,
            rowEnabled: this.projectMode ? this.canCreateProject : this.connectorId.length > 0,
            raised: true,
            onTap: () => {
              if (this.projectMode) {
                this.onCreate();
              } else {
                this.onBrowse();
              }
            },
          })
        }

        if (!this.projectMode || this.homeProject() === null) {
          ListItem() {
            WorkspaceOptionRow({
              colors: this.colors,
              title: resolveString($r('app.string.workspace_home')),
              path: this.homePath ?? '',
              selected: this.homePath !== null && this.selectionKey() === workspacePathKey(this.homePath, this.deviceOs),
              rowEnabled: this.homePath !== null && this.homePath.length > 0,
              onTap: () => {
                const project: AgentProject | null = this.homeProject();
                this.onSelect(new WorkspaceChoice(
                  this.homePath ?? '', project === null ? null : project.id,
                ));
              },
            })
          }
        }

        if (this.projectMode) {
          ForEach(this.availableProjects(), (project: AgentProject) => {
            ListItem() {
              WorkspaceOptionRow({
                colors: this.colors,
                title: project.name,
                path: project.workspacePath,
                selected: this.selectionKey() === workspacePathKey(project.workspacePath, this.deviceOs),
                onTap: () => this.onSelect(new WorkspaceChoice(project.workspacePath, project.id)),
              })
            }
          }, (project: AgentProject) => `project-${project.id}`)

          if (this.availableProjects().length === 0) {
            ListItem() {
              Text($r('app.string.new_session_no_projects'))
                .fontSize(14)
                .fontColor(this.colors.muted)
                .padding({ top: 16, bottom: 16 })
            }
          }
        } else {
          ForEach(this.recent(), (directory: string) => {
            ListItem() {
              WorkspaceOptionRow({
                colors: this.colors,
                title: workspaceProjectName(directory),
                path: directory,
                selected: this.selectionKey() === workspacePathKey(directory, this.deviceOs),
                onTap: () => this.onSelect(new WorkspaceChoice(directory)),
              })
            }
          }, (directory: string) => `directory-${workspacePathKey(directory, this.deviceOs)}`)
        }

        ListItem() {
          Column().height(12)
        }
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
  }
}
