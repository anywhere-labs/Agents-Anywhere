# Anywhere review skill over A2A 1.0

Connector exposes the authenticated Agent Card at `GET /api/v2/connectors/{connector_id}/a2a/agent-card.json` and accepts A2A 1.0 JSON-RPC at `POST /api/v2/connectors/{connector_id}/a2a/review`.
The supported operations are SendMessage, GetTask, ListTasks and CancelTask. Requests name one of the registered projects of the receiving device. The ordinary HTTP endpoint accepts an Anywhere Agent delegation as bearer authentication. Review is unavailable when end-to-end encryption is required. The paired device channel cannot be used for Agent review. Existing review history remains readable.
Optional streaming and push notifications are disabled. SendMessage with returnImmediately returns the persisted task before its worker executes.

Initial SendMessage carries one A2A data part with `schema: "aa.review.request.v1"`, `runId`, `round`, `requirement`, `base`, `sha`, `runtimeId`, `cwd`, optional `projectId` and configured Git `remote`. The optional runtimeType selects claude (default) or pi. The receiver resolves the registered project and the declared local runtime instance. A continuation on the same task and context carries `schema: "aa.review.resume.v1"`. Native permission requests are answered via the existing authenticated user route.

Task metadata `aa.review` includes the task revision and optional source session and attention details. A completed task includes exactly one artifact with a data part containing `schema: "aa.review.result.v1"`, `runId`, `round`, `sha`, `verdict` (approved or changes_requested), `summary` and `blockers` (objects with a `description` and `evidence` field). Task completion means the review concluded, including reviews requiring changes. Whole-run delivery also requires the current commit's implementation check evidence.

The message ID is unique per issuing device and supervisor session. Identical retries return the existing task. The receiver allocates one session ID per task before dispatch. Task reads, list results and cancellation recheck the authenticated supervisor, device scope and target project. Cancellation also requires interrupt authority. The owner authenticates independently of values in A2A messages.

The worker accepts verdicts through its session-scoped `aa_submit_review` MCP tool. The Connector binds the verdict to the task and SHA before producing the artifact. Native approvals keep their original session and notification IDs.
