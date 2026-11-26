import { describe, expect, it, vi } from "vitest"

import {
  bindControlledModeToPage,
  buildAssistantSessionsService,
  ControlledModeController,
  ControlledModeUnavailableError,
  conversationsToSessionList,
  getControlledModeSupport,
  type BrowserServiceHost,
  type ControlledModeDeps,
  type ServingHandle,
} from "@/lib/assistant/controlled-mode"
import type { LocalAssistantConversation } from "@/lib/storage/idb"
import type { PresenceReport } from "@/lib/types/v3"

function conv(id: string, updatedAt: number, title = id): LocalAssistantConversation {
  return { id, title, updatedAt, messages: [] } as unknown as LocalAssistantConversation
}

function makeDeps(overrides: Partial<ControlledModeDeps> = {}) {
  const events: string[] = []
  let stored: { deviceId: string; deviceSecret: string } | null = null
  const reports: PresenceReport[] = []
  let closeServing: () => void = () => undefined
  const host: BrowserServiceHost = {
    async serve(params) {
      events.push(`serve:${params.instanceId}:${params.services.map((s) => s.name).join(",")}`)
      let resolveClosed!: () => void
      const closed = new Promise<void>((r) => (resolveClosed = r))
      closeServing = resolveClosed
      const handle: ServingHandle = {
        closed,
        async close() {
          events.push("serve:close")
          resolveClosed()
        },
      }
      return handle
    },
  }
  const deps: ControlledModeDeps = {
    deviceName: "Browser assistant",
    store: {
      load: async () => stored,
      save: async (e) => {
        events.push(`store:${e.deviceId}`)
        stored = { deviceId: e.deviceId, deviceSecret: e.deviceSecret }
      },
      clear: async () => {
        events.push("store:clear")
        stored = null
      },
    },
    registerDevice: async (payload) => {
      events.push(`register:${payload.platform}:${payload.mode_hint}`)
      return {
        device: { id: "dev_1" } as never,
        device_secret: "aadev_secret_secret_secret",
        notice: "",
      }
    },
    issueDeviceRouterToken: async (payload) => {
      events.push(`token:${payload.device_id}`)
      return {
        device_id: payload.device_id,
        principal: `device:${payload.device_id}`,
        tokens: [{ router_id: "r1", router_url: "wss://router", token: "mt_x", token_id: "t1", expires_at: "2099-01-01T00:00:00Z" }],
      }
    },
    runPresence: async (_entry, items, signal) => {
      events.push("presence:open")
      for await (const report of items) {
        reports.push(report)
        if (signal.aborted) break
      }
      events.push("presence:closed")
    },
    services: (deviceId) => [
      buildAssistantSessionsService({ deviceId, listConversations: async () => [], subscribe: () => () => undefined }),
    ],
    host,
    presenceIntervalMs: 5,
    ...overrides,
  }
  return {
    deps,
    events,
    reports,
    setStored: (v: typeof stored) => (stored = v),
    closeServing: () => closeServing(),
  }
}

describe("controlled mode availability", () => {
  it("is unavailable without a browser serving implementation", () => {
    const support = getControlledModeSupport(null)
    expect(support.available).toBe(false)
    expect(support.blockers[0]).toBe("meshcall_web_server_role")
  })

  it("refuses to start and never registers a device or publishes presence", async () => {
    const { deps, events } = makeDeps({ host: null })
    const controller = new ControlledModeController(deps)
    await expect(controller.start()).rejects.toBeInstanceOf(ControlledModeUnavailableError)
    expect(events).toEqual([])
    expect(controller.state.status).toBe("error")
  })
})

describe("controlled mode controller", () => {
  it("registers, serves aa.v3.Sessions first, then reports presence; stop goes offline", async () => {
    const { deps, events, reports } = makeDeps()
    const controller = new ControlledModeController(deps)
    await controller.start()
    expect(controller.state).toEqual({ status: "online", deviceId: "dev_1", routerId: "r1" })
    await vi.waitFor(() => expect(reports.length).toBeGreaterThan(1))
    expect(events.slice(0, 5)).toEqual([
      "register:linux:normal",
      "store:dev_1",
      "token:dev_1",
      "serve:dev_1:aa.v3.Sessions",
      "presence:open",
    ])
    expect(reports[0]).toMatchObject({ device_id: "dev_1", mode_hint: "normal", platform: "linux" })

    await controller.stop()
    expect(controller.state.status).toBe("off")
    await vi.waitFor(() => expect(events).toContain("presence:closed"))
    expect(events).toContain("serve:close")
  })

  it("reuses the stored device and re-registers when it was deleted elsewhere", async () => {
    const reuse = makeDeps()
    reuse.setStored({ deviceId: "dev_old", deviceSecret: "s".repeat(20) })
    const c1 = new ControlledModeController(reuse.deps)
    await c1.start()
    expect(reuse.events[0]).toBe("token:dev_old")
    expect(reuse.events.some((e) => e.startsWith("register"))).toBe(false)
    await c1.stop()

    const gone = makeDeps()
    gone.setStored({ deviceId: "dev_gone", deviceSecret: "s".repeat(20) })
    const issue = gone.deps.issueDeviceRouterToken
    gone.deps.issueDeviceRouterToken = async (payload) => {
      if (payload.device_id === "dev_gone") throw Object.assign(new Error("unauthorized"), { status: 401 })
      return issue(payload)
    }
    const c2 = new ControlledModeController(gone.deps)
    await c2.start()
    expect(gone.events.slice(0, 3)).toEqual(["store:clear", "register:linux:normal", "store:dev_1"])
    await c2.stop()
  })

  it("goes offline when the Router connection drops", async () => {
    const { deps, closeServing } = makeDeps()
    const controller = new ControlledModeController(deps)
    await controller.start()
    closeServing()
    await vi.waitFor(() => expect(controller.state.status).toBe("error"))
  })

  it("goes offline when the tab is hidden", async () => {
    const { deps } = makeDeps()
    const controller = new ControlledModeController(deps)
    await controller.start()
    const target = new EventTarget() as EventTarget & { visibilityState: string; defaultView: null }
    target.visibilityState = "visible"
    target.defaultView = null
    const unbind = bindControlledModeToPage(controller, target as unknown as Document)
    target.visibilityState = "hidden"
    target.dispatchEvent(new Event("visibilitychange"))
    await vi.waitFor(() => expect(controller.state.status).toBe("off"))
    unbind()
  })
})

describe("aa.v3.Sessions adapter", () => {
  it("maps local conversations to a session list, newest first", () => {
    const list = conversationsToSessionList([conv("a", 1_000), conv("b", 2_000, "")], "dev_1", 5)
    expect(list.projects).toEqual(["/workspace"])
    expect(list.sessions.map((s) => s.id)).toEqual(["b", "a"])
    expect(list.sessions[0]).toMatchObject({ device_id: "dev_1", agent: "pi-lite", title: "Untitled", state: "idle" })
    expect(list.sessions[1].updated_at).toBe(new Date(1_000).toISOString())
  })

  it("watch_list emits a snapshot and again after every change", async () => {
    let listener: (() => void) | null = null
    let items = [conv("a", 1)]
    const service = buildAssistantSessionsService({
      deviceId: "dev_1",
      listConversations: async () => items,
      subscribe: (l) => {
        listener = l
        return () => (listener = null)
      },
    })
    const method = service.methods.watch_list
    if (method.kind !== "server_stream") throw new Error("expected a stream")
    const abort = new AbortController()
    const iter = method.handle({}, { principal: null, signal: abort.signal })[Symbol.asyncIterator]()
    const first = await iter.next()
    expect((first.value as { sessions: unknown[] }).sessions).toHaveLength(1)
    items = [conv("a", 1), conv("b", 2)]
    const second = iter.next()
    listener!()
    expect(((await second).value as { sessions: unknown[] }).sessions).toHaveLength(2)
    abort.abort()
    await iter.return?.(undefined)
    expect(listener).toBeNull()
  })
})
