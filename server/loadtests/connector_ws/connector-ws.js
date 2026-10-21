import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const manifestPath = __ENV.DATA_FILE || "./data.json";
const manifest = JSON.parse(open(manifestPath));
const connectors = manifest.connectors || [];
const baseUrl = (__ENV.BASE_URL || manifest.baseUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
const wsBaseUrl = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
const userToken = manifest.user && manifest.user.accessToken;

const vus = numberEnv("VUS", Math.min(8, connectors.length));
const testDuration = __ENV.TEST_DURATION || "5m";
const connectionSeconds = numberEnv("CONNECTION_SECONDS", 300);
const messagesPerSecond = numberEnv("MESSAGES_PER_SECOND", 20);
const payloadBytes = numberEnv("PAYLOAD_BYTES", 1024);
const itemsPerSession = numberEnv("ITEMS_PER_SESSION", 4);
const checkpointEvery = numberEnv("CHECKPOINT_EVERY", 20);
const readbackIntervalMs = numberEnv("READBACK_INTERVAL_MS", 1000);
const reconnectPauseSeconds = numberEnv("RECONNECT_PAUSE_SECONDS", 1);
const mode = __ENV.MODE || "steady";
const timelinePercent = numberEnv("TIMELINE_PERCENT", 80);
const statePercent = numberEnv("STATE_PERCENT", 10);

if (!connectors.length || !userToken) {
  throw new Error(`invalid load-test manifest: ${manifestPath}`);
}
if (vus < 1 || vus > connectors.length) {
  throw new Error(`VUS must be between 1 and connector count (${connectors.length})`);
}
if (timelinePercent < 0 || statePercent < 0 || timelinePercent + statePercent > 100) {
  throw new Error("TIMELINE_PERCENT and STATE_PERCENT must be non-negative and sum to at most 100");
}
if (messagesPerSecond <= 0 || payloadBytes < 0 || itemsPerSession < 1 || checkpointEvery < 1) {
  throw new Error("message rate and item settings are invalid");
}

export const options = {
  scenarios: {
    connector_ws: {
      executor: "constant-vus",
      vus,
      duration: testDuration,
      gracefulStop: "15s",
    },
  },
  thresholds: {
    ws_connection_success: ["rate>0.99"],
    ws_connection_errors: ["count==0"],
    ws_send_errors: ["count==0"],
    rpc_response_errors: ["count==0"],
    readback_success: ["rate>0.99"],
    checkpoint_delivery: ["rate>0.95"],
    sync_lag_ms: ["p(95)<2000", "p(99)<5000"],
  },
};

const wsConnections = new Counter("ws_connections");
const wsConnectionSuccess = new Rate("ws_connection_success");
const wsConnectionErrors = new Counter("ws_connection_errors");
const wsMessagesSent = new Counter("ws_messages_sent");
const wsSendErrors = new Counter("ws_send_errors");
const rpcRequests = new Counter("rpc_requests");
const rpcResponseErrors = new Counter("rpc_response_errors");
const checkpointsSent = new Counter("checkpoints_sent");
const checkpointsObserved = new Counter("checkpoints_observed");
const checkpointDelivery = new Rate("checkpoint_delivery");
const readbackSuccess = new Rate("readback_success");
const syncLag = new Trend("sync_lag_ms", true);
const connectorAuthDuration = new Trend("connector_auth_duration_ms", true);

export default function () {
  const connector = connectors[(__VU - 1) % connectors.length];
  const accessToken = authenticateConnector(connector);
  if (!accessToken) {
    wsConnectionSuccess.add(false);
    wsConnectionErrors.add(1);
    sleep(reconnectPauseSeconds);
    return;
  }

  const sessions = connector.sessions || [];
  if (!sessions.length) {
    throw new Error(`connector ${connector.id} has no sessions`);
  }

  let sequence = 0;
  let timelineSequence = 0;
  let sendCredit = 0;
  const revisions = {};
  const pendingCheckpoints = {};
  const filler = payloadBytes ? "x".repeat(payloadBytes) : "";

  let opened = false;
  const response = ws.connect(
    `${wsBaseUrl}/api/v2/connector/ws`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Device-OS": "linux",
      },
      tags: { name: "connector_ws" },
    },
    function (socket) {
      socket.on("open", function () {
        opened = true;
        wsConnections.add(1);
        wsConnectionSuccess.add(true);
        check(true, { "connector websocket upgraded": (upgraded) => upgraded });

        socket.setInterval(function () {
          sendCredit += messagesPerSecond / 10;
          while (sendCredit >= 1) {
            sequence += 1;
            try {
              const frame = nextNotification(
                connector,
                sessions,
                sequence,
                timelineSequence,
                revisions,
                pendingCheckpoints,
                filler,
              );
              if (frame.method === "timeline.itemUpsert") {
                timelineSequence += 1;
              }
              socket.send(JSON.stringify(frame));
              wsMessagesSent.add(1, { method: frame.method });
            } catch (error) {
              wsSendErrors.add(1);
            }
            sendCredit -= 1;
          }
        }, 100);

        socket.setInterval(function () {
          observeOldestCheckpoint(pendingCheckpoints);
        }, readbackIntervalMs);

        socket.setTimeout(function () {
          socket.close();
        }, connectionSeconds * 1000);
      });

      socket.on("message", function (raw) {
        let message;
        try {
          message = JSON.parse(raw);
        } catch (error) {
          rpcResponseErrors.add(1);
          return;
        }
        if (message.type !== "request" || !message.id) {
          return;
        }
        rpcRequests.add(1, { method: message.method || "unknown" });
        try {
          socket.send(JSON.stringify(rpcResponse(message)));
        } catch (error) {
          rpcResponseErrors.add(1);
        }
      });

      socket.on("error", function () {
        wsConnectionErrors.add(1);
      });

      socket.on("close", function () {
        for (const sessionId of Object.keys(pendingCheckpoints)) {
          checkpointDelivery.add(false);
          delete pendingCheckpoints[sessionId];
        }
      });
    },
  );

  if (!opened) {
    wsConnectionSuccess.add(false);
    check(response, { "connector websocket upgraded": (result) => result && result.status === 101 });
    wsConnectionErrors.add(1);
  }
  sleep(reconnectPauseSeconds);
}

function nextNotification(
  connector,
  sessions,
  sequence,
  timelineSequence,
  revisions,
  pendingCheckpoints,
  filler,
) {
  const session = sessions[sequence % sessions.length];
  const bucket = sequence % 100;
  if (bucket < timelinePercent) {
    return timelineNotification(
      connector,
      session,
      sequence,
      timelineSequence + 1,
      revisions,
      pendingCheckpoints,
      filler,
    );
  }
  if (bucket < timelinePercent + statePercent) {
    return notification("session.state.updated", {
      sessionId: session.id,
      externalSessionId: session.externalSessionId,
      runtime: "codex",
      runtimeId: "codex",
      status: sequence % 2 ? "running" : "idle",
      selections: {},
      statusReason: "load_test",
      metadata: { producerSequence: sequence },
    });
  }
  return notification("session.source.updated", {
    sessionId: session.id,
    externalSessionId: session.externalSessionId,
    runtime: "codex",
    runtimeId: "codex",
    availability: "available",
    reason: "load-test observation",
    observedAt: new Date().toISOString(),
    observationOrigin: "event",
  });
}

function timelineNotification(
  connector,
  session,
  sequence,
  timelineSequence,
  revisions,
  pendingCheckpoints,
  filler,
) {
  const checkpoint = timelineSequence % checkpointEvery === 0;
  const slot = timelineSequence % itemsPerSession;
  const append = mode === "append";
  const itemId = checkpoint
    ? `k6-checkpoint-${session.id}`
    : append
      ? `k6-append-${session.id}-${sequence}`
      : `k6-stream-${session.id}-${slot}`;
  const key = `${session.id}:${itemId}`;
  const revision = append ? 1 : (revisions[key] || 0) + 1;
  revisions[key] = revision;
  const sentAt = Date.now();
  if (checkpoint) {
    if (pendingCheckpoints[session.id]) {
      checkpointDelivery.add(false);
    }
    pendingCheckpoints[session.id] = { itemId, sequence, sentAt };
    checkpointsSent.add(1);
  }
  return notification("timeline.itemUpsert", {
    sessionId: session.id,
    runtime: "codex",
    runtimeId: "codex",
    item: {
      id: itemId,
      sessionId: session.id,
      type: "message",
      status: "running",
      role: "assistant",
      content: {
        kind: "markdown",
        text: filler,
        producerSequence: sequence,
        producerSentAtMs: sentAt,
        connectorId: connector.id,
      },
      source: {
        runtime: "codex",
        sessionId: session.externalSessionId,
        itemId,
        event: "loadtest.item.updated",
      },
      orderSeq: append ? sequence : checkpoint ? itemsPerSession + 1 : slot + 1,
      revision,
      contentHash: `loadtest:${sequence}:${revision}:${filler.length}`,
    },
  });
}

function observeOldestCheckpoint(pendingCheckpoints) {
  let sessionId;
  let expected;
  for (const [candidateSessionId, candidate] of Object.entries(pendingCheckpoints)) {
    if (!expected || candidate.sentAt < expected.sentAt) {
      sessionId = candidateSessionId;
      expected = candidate;
    }
  }
  if (!expected) {
    return;
  }
  const response = http.get(
    `${baseUrl}/api/v2/sessions/${encodeURIComponent(sessionId)}/timeline?mode=latest&limit=100`,
    {
      headers: { Authorization: `Bearer ${userToken}`, Accept: "application/json" },
      tags: { name: "checkpoint_readback" },
      timeout: "5s",
    },
  );
  if (response.status !== 200) {
    readbackSuccess.add(false);
    return;
  }
  readbackSuccess.add(true);
  let body;
  try {
    body = response.json();
  } catch (error) {
    readbackSuccess.add(false);
    return;
  }
  const item = (body.items || []).find((candidate) => candidate.id === expected.itemId);
  const observedSequence = item && item.content && item.content.producerSequence;
  if (observedSequence >= expected.sequence) {
    syncLag.add(Date.now() - expected.sentAt);
    checkpointsObserved.add(1);
    checkpointDelivery.add(true);
    delete pendingCheckpoints[sessionId];
  }
}

function authenticateConnector(connector) {
  const started = Date.now();
  const response = http.post(`${baseUrl}/api/v2/connector/auth`, null, {
    headers: { Authorization: `Connector ${connector.id}:${connector.token}` },
    tags: { name: "connector_auth" },
    timeout: "10s",
  });
  connectorAuthDuration.add(Date.now() - started);
  if (response.status !== 200) {
    return null;
  }
  try {
    return response.json("accessToken");
  } catch (error) {
    return null;
  }
}

function rpcResponse(request) {
  let result;
  switch (request.method) {
    case "runtime.discover":
      result = runtimeDiscovery();
      break;
    case "runtime.capabilities":
    case "session.capabilities":
      result = { capabilitySet: { revision: 1, capabilities: [] } };
      break;
    case "runtime.modelCatalog":
      result = { catalog: { runtime: "codex", revision: 1, models: [] } };
      break;
    case "runtime.permissionCatalog":
      result = { catalog: { runtime: "codex", revision: 1, permissions: [] } };
      break;
    case "runtime.commands":
    case "session.commands":
      result = { commands: [] };
      break;
    case "session.notices":
      result = { notices: [] };
      break;
    case "runtime.start":
    case "runtime.stop":
      result = { ok: true };
      break;
    default:
      return {
        id: request.id,
        type: "response",
        ok: false,
        error: { code: "loadtest_unsupported", message: `unsupported ${request.method}` },
      };
  }
  return { id: request.id, type: "response", ok: true, result };
}

function runtimeDiscovery() {
  return {
    runtimeTypes: [
      {
        runtimeType: "codex",
        displayName: "Codex Load Test",
        description: "Synthetic runtime used by Connector WebSocket load tests",
        available: true,
        reason: null,
        recommended: true,
        recommendationRank: 0,
        implementationType: null,
        configSchema: {
          revision: 1,
          schema: { type: "object", properties: {}, additionalProperties: false },
          uiSchema: {},
          defaults: {},
          metadata: { loadTest: true },
        },
        capabilities: {},
        metadata: { loadTest: true },
        instancePolicy: "single",
        maxInstances: 1,
      },
    ],
  };
}

function notification(method, params) {
  return { type: "notification", method, params };
}

function numberEnv(name, fallback) {
  const value = Number(__ENV[name] || fallback);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  return value;
}
