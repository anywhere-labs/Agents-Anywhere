/* eslint-disable */
/** Generated from contracts/agent-tools/1.0/errors.json. Do not edit; run `yarn contracts:generate`. */

export const AGENT_TOOL_ERRORS = {
  "version": "1.0",
  "errors": [
    {
      "code": "agent_grant_revoked",
      "message": "The collaboration grant of this session was revoked (the session closed, or a person turned collaboration off)."
    },
    {
      "code": "agent_scope_denied",
      "message": "The target is outside this session's scope: another device without cross-device collaboration, a runtime or directory not allowed, or the session itself."
    },
    {
      "code": "agent_depth_exceeded",
      "message": "Creating the session would exceed the maximum depth of sessions created by Agents."
    },
    {
      "code": "agent_children_exceeded",
      "message": "Too many sessions created by this session are open."
    },
    {
      "code": "agent_authority_exceeded",
      "message": "The action needs an authority this supervision does not have; a person can grant it, or use aa_escalate."
    },
    {
      "code": "agent_supervision_cycle",
      "message": "The supervision would make two sessions supervise each other."
    },
    {
      "code": "agent_supervision_exists",
      "message": "This session already supervises the target."
    },
    {
      "code": "agent_supervision_not_found",
      "message": "No such supervision."
    },
    {
      "code": "agent_peer_not_trusted",
      "message": "End-to-end encryption is on and the target device has not trusted this device's Agent yet; a person approves it once from a client trusted by both devices."
    },
    {
      "code": "agent_wake_budget_exceeded",
      "message": "The supervision woke this session too often and was paused; a person resumes it."
    },
    {
      "code": "agent_target_unknown",
      "message": "No such session, or its device is unknown."
    },
    {
      "code": "agent_route_denied",
      "message": "The Server refused a route that delegated Agents may not call."
    },
    {
      "code": "agent_delegation_unavailable",
      "message": "Cross-device collaboration is off for this account, or the Server could not issue a delegation."
    },
    {
      "code": "agent_tools_unavailable",
      "message": "The Connector is not running or does not serve the collaboration tools."
    }
  ],
  "passthrough": [
    "connector_offline",
    "command_outcome_unknown",
    "conflict",
    "invalid_argument",
    "runtime_unavailable"
  ]
} as const
