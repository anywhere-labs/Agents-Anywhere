import type { NativeRuntime } from './native.js'
import { sessionId } from './identity.js'

/** Include empty projects and all explicit members, even archived or unloaded sessions. */
export function workspaceInventory(native: NativeRuntime, namespace: string) {
  return { kind: 'workspace.inventory', complete: true,
    workspaces: native.workspaces().map(workspace => ({ ...workspace,
      sessionIds: workspace.sessionIds.map(id => sessionId(namespace, id)),
    })) }
}
