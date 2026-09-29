/**
 * Recent workspace paths for the new-session page.
 *
 * The rules that matter here are the ones the user meets as "the same folder
 * twice" or "my project is missing from the list":
 *
 *   - deduplication goes through `workspacePathKey`, not through the text, so
 *     `/Users/me/project/` and `/Users/me/project` are one workspace — and on
 *     Windows, where the file system ignores case, `C:\Code\App` and
 *     `c:/code/app` are one workspace too;
 *   - the order is Desktop's: sessions with a running one first, then projects
 *     with a pinned one first, deduplicated by that key with the home directory
 *     removed, because the page always offers the home directory explicitly;
 *   - `availableProjectName` must keep handing out a free name, and it counts
 *     code points so a name ending in an emoji is not cut in half.
 *
 * The module also carries two helpers it borrows from Android's
 * `WorkspaceProjects.kt` / `SidebarSelectors.kt`, because both exist only in
 * service of this ordering; they are pinned here with it.
 */
import { loadModule, suite, expect, finish } from './lib.mjs';

const workspaces = await loadModule('feature/sessions/NewSessionWorkspaces.ets');
const appModel = await loadModule('model/AgentSession.ets');
const SessionStatus = appModel.SessionStatus;
suite('feature/sessions/NewSessionWorkspaces.ets');

/** An `AgentSession` with only the fields this module reads made explicit. */
function session(overrides = {}) {
  return {
    id: 's1',
    connectorId: 'c1',
    projectId: null,
    deviceName: 'Mac',
    title: '',
    summary: '',
    cwd: '/Users/me/project',
    workspaceLabel: '',
    runtime: 'codex',
    runtimeLabel: 'Codex',
    status: SessionStatus.Idle,
    statusLabel: '',
    updatedAtLabel: '',
    metaLabel: '',
    pinned: false,
    archived: false,
    unread: false,
    lastReadSeq: 0,
    takeover: false,
    connectorOnline: true,
    live: false,
    sortKey: '',
    updatedSeq: 1,
    runtimeId: 'r1',
    runtimeType: 'codex',
    runtimeName: 'Codex',
    archivedAt: null,
    optimisticTopUntil: 0,
    sortAt: '2024-01-02T03:04:05Z',
    ...overrides,
  };
}

/** An `AgentProject` with the fields the comparator reads made explicit. */
function project(overrides = {}) {
  return {
    id: 'p1',
    userId: 'u1',
    connectorId: 'c1',
    name: 'Project',
    workspacePath: '/Users/me/project',
    pinned: false,
    pinnedAt: null,
    activeSessionCount: 0,
    lastActivityAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    manuallyCreated: false,
    sidebarSessionCounts: null,
    ...overrides,
  };
}

// ------------------------------------------------------- workspacePathKey

expect('a trailing slash is not a second workspace',
  workspaces.workspacePathKey('/Users/me/project/', null), '/Users/me/project');

expect('dot segments are dropped and .. pops on POSIX, but never pops past the root',
  {
    popped: workspaces.workspacePathKey('/a/b/../c', null),
    current: workspaces.workspacePathKey('/a/./b', null),
    root: workspaces.workspacePathKey('/..', null),
  },
  { popped: '/a/c', current: '/a/b', root: '/' });

expect('a blank path has an empty key',
  workspaces.workspacePathKey('   ', null), '');

expect('a UNC path keys as //server/share, while a third slash falls back to a POSIX key',
  {
    unc: workspaces.workspacePathKey('\\\\server\\share', null),
    threeSlashes: workspaces.workspacePathKey('///server/share', null),
  },
  { unc: '//server/share', threeSlashes: '/server/share' });

expect('a drive-letter path is recognized as Windows: backslashes unify and the key lowercases, with .. kept literally',
  {
    drive: workspaces.workspacePathKey('C:\\Users\\Me', null),
    dotdot: workspaces.workspacePathKey('C:\\a\\..\\b', null),
  },
  { drive: 'c:/users/me', dotdot: 'c:/a/../b' });

expect('a Windows device lowercases a path spelled with forward slashes',
  workspaces.workspacePathKey('/Users/Me', 'windows'), '/users/me');

// --------------------------------------------------- workspaceProjectName

expect('the label is the last segment',
  {
    posix: workspaces.workspaceProjectName('/Users/me/project/'),
    uncShare: workspaces.workspaceProjectName('\\\\server\\share\\proj'),
  },
  { posix: 'project', uncShare: 'proj' });

expect('a bare drive, a bare UNC share and an empty path are all called Workspace',
  {
    drive: workspaces.workspaceProjectName('C:\\'),
    share: workspaces.workspaceProjectName('\\\\server\\share'),
    empty: workspaces.workspaceProjectName(''),
  },
  { drive: 'Workspace', share: 'Workspace', empty: 'Workspace' });

expect('a drive letter without a separator is not a Windows path, so it stays its own label',
  {
    bareDrive: workspaces.workspaceProjectName('C:'),
    slashesOnly: workspaces.workspaceProjectName('///'),
  },
  { bareDrive: 'C:', slashesOnly: 'Workspace' });

// ---------------------------------------------------------- timestampMillis

expect('an unreadable timestamp is 0, including a date without a time or offset',
  {
    missing: workspaces.timestampMillis(null),
    dateOnly: workspaces.timestampMillis('2024-01-02'),
    noOffset: workspaces.timestampMillis('2024-01-02T03:04:05'),
    blank: workspaces.timestampMillis('   '),
  },
  { missing: 0, dateOnly: 0, noOffset: 0, blank: 0 });

expect('a UTC instant becomes its exact millis',
  workspaces.timestampMillis('2024-01-02T03:04:05Z'), 1704164645000);

expect('fractional seconds and a numeric offset are honoured',
  {
    millis: workspaces.timestampMillis('2024-01-02T03:04:05.500Z'),
    offset: workspaces.timestampMillis('2024-01-02T03:04:05+02:00'),
  },
  { millis: 1704164645500, offset: 1704157445000 });

// ---------------------------------------------------------- workspaceProject

const projects = [
  project({ id: 'p1', connectorId: 'c1', workspacePath: '/Users/me/project', name: 'Project' }),
  project({ id: 'p2', connectorId: 'c2', workspacePath: '/other', name: 'Other' }),
];

expect('a project matches through the path key, so a trailing slash still finds it',
  (workspaces.workspaceProject(projects, 'c1', '/Users/me/project/', null) || {}).id, 'p1');

expect('a blank path and another device\'s connector both find nothing',
  {
    blank: workspaces.workspaceProject(projects, 'c1', '   ', null),
    otherDevice: workspaces.workspaceProject(projects, 'c2', '/Users/me/project', null),
  },
  { blank: null, otherDevice: null });

// ------------------------------------------------------ availableProjectName

expect('an empty or padded name is trimmed, and a blank one becomes Workspace',
  {
    blank: workspaces.availableProjectName('', []),
    padded: workspaces.availableProjectName('  App  ', []),
  },
  { blank: 'Workspace', padded: 'App' });

expect('a taken name and its (1) both push the suffix on, and the renamed project is ignored',
  {
    ladder: workspaces.availableProjectName('App', [
      project({ id: 'p1', name: 'App' }),
      project({ id: 'p2', name: 'App (1)' }),
    ]),
    ignored: workspaces.availableProjectName('App', [project({ id: 'p1', name: 'App' })], 'p1'),
  },
  { ladder: 'App (2)', ignored: 'App' });

expect('a reserved name is collision-checked too',
  workspaces.availableProjectName('App', [], null, new Set(['App'])), 'App (1)');

expect('the cap counts code points, so an emoji name is truncated without being cut in half',
  (() => {
    const plain = workspaces.availableProjectName('A'.repeat(256), []);
    const emoji = workspaces.availableProjectName('😀'.repeat(300), []);
    return {
      plainPoints: Array.from(plain).length,
      emojiPoints: Array.from(emoji).length,
      wholeEmoji: emoji.endsWith('😀'),
    };
  })(),
  { plainPoints: 255, emojiPoints: 255, wholeEmoji: true });

// ---------------------------------------------------- recentWorkspacePaths

const NOW = 1_000_000_000;

expect('no connector means no recent workspaces',
  {
    missing: workspaces.recentWorkspacePaths(null, null, null, [session({})], [], NOW),
    blank: workspaces.recentWorkspacePaths('  ', null, null, [session({})], [], NOW),
  },
  { missing: [], blank: [] });

expect('a running session comes first, and equal times fall back to the id descending',
  {
    running: workspaces.recentWorkspacePaths('c1', null, null, [
      session({ id: 'a', cwd: '/idle', status: SessionStatus.Idle, sortAt: '2024-01-02T03:04:05Z' }),
      session({ id: 'b', cwd: '/running', status: SessionStatus.Running, sortAt: '2020-01-02T03:04:05Z' }),
    ], [], NOW),
    sameTime: workspaces.recentWorkspacePaths('c1', null, null, [
      session({ id: 'a', cwd: '/a', sortAt: '2024-01-02T03:04:05Z' }),
      session({ id: 'b', cwd: '/b', sortAt: '2024-01-02T03:04:05Z' }),
    ], [], NOW),
  },
  { running: ['/running', '/idle'], sameTime: ['/b', '/a'] });

expect('a repeated session id keeps the entry with the higher sequence',
  workspaces.recentWorkspacePaths('c1', null, null, [
    session({ id: 's1', cwd: '/stale', updatedSeq: 1 }),
    session({ id: 's1', cwd: '/fresh', updatedSeq: 5 }),
  ], [], NOW), ['/fresh']);

expect('an optimistic top-out ranks as running, and the boundary is exclusive',
  {
    promoted: workspaces.recentWorkspacePaths('c1', null, null, [
      session({ id: 'a', cwd: '/topped', optimisticTopUntil: NOW + 1000 }),
      session({ id: 'b', cwd: '/plain', optimisticTopUntil: 0 }),
    ], [], NOW),
    expired: workspaces.recentWorkspacePaths('c1', null, null, [
      session({ id: 'a', cwd: '/boundary', optimisticTopUntil: NOW }),
      session({ id: 'b', cwd: '/after', optimisticTopUntil: NOW + 1 }),
    ], [], NOW),
  },
  { promoted: ['/topped', '/plain'], expired: ['/after', '/boundary'] });

expect('the home directory is dropped but still consumes the seen key, and both spellings dedup',
  workspaces.recentWorkspacePaths('c1', null, '/Users/me', [
    session({ id: 's2', cwd: '/a/b/' }),
    session({ id: 's1', cwd: '/Users/me' }),
  ], [project({ id: 'p1', workspacePath: '/a/b' })], NOW), ['/a/b/']);

expect('project paths follow the sessions, pinned first and then most recent first',
  workspaces.recentWorkspacePaths('c1', null, null, [session({ id: 's1', cwd: '/session' })], [
    project({ id: 'pOld', workspacePath: '/older', lastActivityAt: '2024-01-01T00:00:00Z' }),
    project({ id: 'pPin', workspacePath: '/pinned', pinned: true, lastActivityAt: '2020-01-01T00:00:00Z' }),
    project({ id: 'pNew', workspacePath: '/newer', lastActivityAt: '2025-01-01T00:00:00Z' }),
  ], NOW), ['/session', '/pinned', '/newer', '/older']);

expect('another connector\'s sessions and a blank cwd contribute nothing',
  workspaces.recentWorkspacePaths('c1', null, null, [
    session({ id: 's1', connectorId: 'c2', cwd: '/other' }),
    session({ id: 's2', cwd: '   ' }),
  ], [], NOW), []);

finish();
