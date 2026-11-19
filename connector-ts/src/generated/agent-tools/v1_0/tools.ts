/* eslint-disable */
/** Generated from contracts/agent-tools/1.0/tools.json. Do not edit; run `yarn contracts:generate`. */

/** The collaboration tools the injected `aa` tool server lists (MCP `tools/list`). */
export const AGENT_TOOLS = {
  "version": "1.0",
  "server": "aa",
  "tools": [
    {
      "name": "aa_targets",
      "verb": "targets",
      "description": "List the Agents Anywhere devices, runtime instances (Codex, Claude, Pi, DSH...) and sessions this session may work with, including sessions it created and supervises.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "includeSessions": {
            "type": "boolean",
            "description": "Also list recent sessions (default true)."
          }
        },
        "required": [],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_spawn",
      "verb": "spawn",
      "description": "Create a new Agents Anywhere session on a runtime instance (for example a Codex or Claude session) in a working directory and send it its first message. By default this session supervises it and is woken when it finishes a turn, fails, needs an approval or proposes a plan.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "runtimeId": {
            "type": "string",
            "description": "Runtime instance id from aa_targets."
          },
          "runtime": {
            "type": "string",
            "description": "Runtime type (codex, claude, pi, dsh, hermes) when runtimeId is not given; the device's default instance of that type is used."
          },
          "deviceId": {
            "type": "string",
            "description": "Device to run on; default this device."
          },
          "cwd": {
            "type": "string",
            "description": "Absolute working directory."
          },
          "prompt": {
            "type": "string",
            "description": "The first message."
          },
          "title": {
            "type": "string"
          },
          "mode": {
            "enum": [
              "normal",
              "plan",
              "goal"
            ],
            "description": "plan: start in plan mode; goal: the prompt is the session goal."
          },
          "supervise": {
            "type": "boolean",
            "description": "Supervise the new session (default true)."
          },
          "triggers": {
            "type": "array",
            "items": {
              "enum": [
                "turn_end",
                "turn_failed",
                "notice_opened",
                "plan_proposed",
                "goal_changed",
                "stalled"
              ]
            },
            "description": "When to wake this session about the target. Default: turn_end, turn_failed, notice_opened, plan_proposed, stalled."
          },
          "projectId": {
            "type": "string",
            "description": "Target project's id. On the normal cross-device route, the Server can also resolve the registered project from the target cwd."
          }
        },
        "required": [
          "cwd",
          "prompt"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_send",
      "verb": "send",
      "description": "Send a message to another session. If it is busy the message is queued and runs after its current turn.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "The target session id (returned by aa_spawn or aa_targets)."
          },
          "deviceId": {
            "type": "string",
            "description": "The target session's device; optional when the session is on this device or was created by this session."
          },
          "message": {
            "type": "string"
          }
        },
        "required": [
          "sessionId",
          "message"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_steer",
      "verb": "steer",
      "description": "Steer another session's current turn with an extra instruction (when its runtime supports steering; otherwise the message is queued).",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "The target session id (returned by aa_spawn or aa_targets)."
          },
          "deviceId": {
            "type": "string",
            "description": "The target session's device; optional when the session is on this device or was created by this session."
          },
          "message": {
            "type": "string"
          }
        },
        "required": [
          "sessionId",
          "message"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_interrupt",
      "verb": "interrupt",
      "description": "Interrupt another session's current turn.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "The target session id (returned by aa_spawn or aa_targets)."
          },
          "deviceId": {
            "type": "string",
            "description": "The target session's device; optional when the session is on this device or was created by this session."
          }
        },
        "required": [
          "sessionId"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_status",
      "verb": "status",
      "description": "Status of another session: running or idle, open approvals, queue length, plan and goal state, clock.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "The target session id (returned by aa_spawn or aa_targets)."
          },
          "deviceId": {
            "type": "string",
            "description": "The target session's device; optional when the session is on this device or was created by this session."
          }
        },
        "required": [
          "sessionId"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_read",
      "verb": "read",
      "description": "Read what another session did since a position: a compact digest by default, or the items themselves.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "The target session id (returned by aa_spawn or aa_targets)."
          },
          "deviceId": {
            "type": "string",
            "description": "The target session's device; optional when the session is on this device or was created by this session."
          },
          "afterSeq": {
            "type": "integer",
            "minimum": 0,
            "description": "Clock position to read after; default the last position this session read."
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "detail": {
            "type": "boolean",
            "description": "Return item previews instead of a digest."
          }
        },
        "required": [
          "sessionId"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_wait",
      "verb": "wait",
      "description": "Wait up to 50 seconds for another session's next turn end, failure, approval or plan. Returns still_running on timeout; for longer work rely on supervision wake-ups instead of repeated waits.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "The target session id (returned by aa_spawn or aa_targets)."
          },
          "deviceId": {
            "type": "string",
            "description": "The target session's device; optional when the session is on this device or was created by this session."
          },
          "timeoutSeconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50
          }
        },
        "required": [
          "sessionId"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_respond",
      "verb": "respond",
      "description": "Answer another session's open approval or question. Needs the respondApproval authority, which a person grants; otherwise use aa_escalate.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "The target session id (returned by aa_spawn or aa_targets)."
          },
          "deviceId": {
            "type": "string",
            "description": "The target session's device; optional when the session is on this device or was created by this session."
          },
          "noticeId": {
            "type": "string"
          },
          "optionId": {
            "type": "string",
            "description": "The option to choose (from aa_status)."
          },
          "text": {
            "type": "string",
            "description": "Free-text answer, for questions."
          }
        },
        "required": [
          "sessionId",
          "noticeId"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_plan_review",
      "verb": "review_plan",
      "description": "Approve or reject another session's proposed plan. Needs the reviewPlan authority.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "The target session id (returned by aa_spawn or aa_targets)."
          },
          "deviceId": {
            "type": "string",
            "description": "The target session's device; optional when the session is on this device or was created by this session."
          },
          "decision": {
            "enum": [
              "approve",
              "reject"
            ]
          },
          "contentHash": {
            "type": "string",
            "description": "The plan revision's contentHash (from aa_status); required to approve."
          },
          "feedback": {
            "type": "string"
          }
        },
        "required": [
          "sessionId",
          "decision"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_supervise",
      "verb": "supervise",
      "description": "Start supervising (again) a session this session created, with the given triggers.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "The target session id (returned by aa_spawn or aa_targets)."
          },
          "deviceId": {
            "type": "string",
            "description": "The target session's device; optional when the session is on this device or was created by this session."
          },
          "triggers": {
            "type": "array",
            "items": {
              "enum": [
                "turn_end",
                "turn_failed",
                "notice_opened",
                "plan_proposed",
                "goal_changed",
                "stalled"
              ]
            },
            "description": "When to wake this session about the target. Default: turn_end, turn_failed, notice_opened, plan_proposed, stalled."
          }
        },
        "required": [
          "sessionId"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_unsupervise",
      "verb": "unsupervise",
      "description": "Stop supervising a session.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "The target session id (returned by aa_spawn or aa_targets)."
          },
          "deviceId": {
            "type": "string",
            "description": "The target session's device; optional when the session is on this device or was created by this session."
          }
        },
        "required": [
          "sessionId"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_escalate",
      "verb": "escalate",
      "description": "Hand a decision to the person: shows the question in this session (and the target session) as waiting for them.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string"
          },
          "context": {
            "type": "string"
          },
          "sessionId": {
            "type": "string",
            "description": "The session the question is about."
          },
          "deviceId": {
            "type": "string"
          }
        },
        "required": [
          "question"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_close",
      "verb": "close",
      "description": "Close a session this session created and stop supervising it.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "The target session id (returned by aa_spawn or aa_targets)."
          },
          "deviceId": {
            "type": "string",
            "description": "The target session's device; optional when the session is on this device or was created by this session."
          }
        },
        "required": [
          "sessionId"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_review",
      "verb": "spawn",
      "description": "Run a user-requested Codex implementation plus independent Claude Code or Pi review as a persistent task. Start once with the user’s chosen devices, registered review project and requirement. Progress and handoffs continue in the main session. Use advance to resume after an explicit user decision or a recoverable failure, and status to read the run. Do not declare delivery before this tool reports delivered.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "action": {
            "enum": [
              "start",
              "advance",
              "status"
            ]
          },
          "requirement": {
            "type": "string"
          },
          "implementationRuntimeId": {
            "type": "string"
          },
          "reviewDeviceId": {
            "type": "string"
          },
          "reviewRuntimeId": {
            "type": "string"
          },
          "reviewRuntimeType": {
            "enum": [
              "claude",
              "pi"
            ],
            "description": "Review runtime type. Defaults to claude. Set pi to review with Pi."
          },
          "reviewProjectId": {
            "type": "string",
            "description": "Registered project on the review device."
          },
          "reviewCwd": {
            "type": "string",
            "description": "Repository root of the review project's existing checkout."
          },
          "remote": {
            "type": "string",
            "description": "Configured shared Git remote name; defaults to origin. The Codex worker uses its existing permissions if it needs to publish a temporary reference."
          }
        },
        "required": [
          "action"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "aa_submit_review",
      "verb": "reviewPlan",
      "description": "Submit the verdict for the exact candidate already bound to this dedicated read-only review session. Include a description and file location or evidence for every blocker. Use changes_requested when any blocker remains, or approved with an empty list.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "verdict": {
            "enum": [
              "approved",
              "changes_requested"
            ]
          },
          "summary": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2400
          },
          "blockers": {
            "type": "array",
            "maxItems": 20,
            "items": {
              "type": "object",
              "properties": {
                "description": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 600
                },
                "evidence": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 300
                }
              },
              "required": [
                "description",
                "evidence"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "verdict",
          "summary",
          "blockers"
        ],
        "additionalProperties": false
      }
    }
  ]
} as const
