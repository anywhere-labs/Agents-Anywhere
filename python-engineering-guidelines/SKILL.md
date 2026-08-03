---
name: python-engineering-guidelines
description: General Python engineering standards for writing, reviewing, and refactoring maintainable code. Use when Codex works on Python code, especially in medium/large projects, runtime adapters, APIs, SDK integrations, async services, stateful systems, or refactors where readability, explicit typing, module boundaries, side effects, and long-term maintainability matter.
---

# Python Engineering Guidelines

Use this skill to write Python as explicit, typed, readable engineering code. Python is dynamic, but project code should not become dynamic mud: keep dynamic behavior at boundaries, make business data typed, make side effects visible, and let module paths express architecture.

The core standard:

> A reader should be able to understand what a piece of Python code reads, changes, returns, and may leave behind on failure without running it, globally searching for hidden fields, or guessing dynamic shapes.

## 1. Use dynamic language features only at boundaries

Prefer boring, explicit Python in business code.

Use these freely:

- `dataclass(frozen=True, slots=True)` for internal domain objects, request/result objects, projections, and state transitions.
- `pydantic.BaseModel` for external input/output, API contracts, config schemas, and wire payloads.
- `Enum` or `Literal` for finite states.
- `Protocol` or `ABC` for cross-layer contracts.
- Explicit imports that make dependencies visible.

Use these only with a clear boundary reason:

- `Any`
- `dict[str, Any]`
- `.get(...)` on known business data
- `getattr`, `setattr`, `hasattr`
- `vars`, `__dict__`
- `model_dump`
- `inspect`
- decorator magic
- metaclasses
- monkey patching
- runtime code generation

Allowed boundary reasons include JSON/HTTP/WebSocket serialization, CLI parsing, SDK adapters, plugin/discovery systems, unknown fallback diagnostics, migrations, and tests/fakes.

Business logic should not depend on dynamic probing to understand normal data.

## 2. Prefer clear syntax over clever syntax

Optimize for reading, not brevity.

Prefer:

- early returns to reduce nesting;
- named intermediate variables for business conditions;
- explicit `if`/`else` for meaningful branches;
- keyword arguments for complex calls;
- one main operation per line;
- straightforward loops when comprehension logic becomes dense.

Avoid:

- nested ternary expressions;
- long chained calls;
- multi-layer comprehensions;
- truthy/falsy shortcuts for business states;
- using `or` to merge values with different meanings;
- chained `.get(...).get(...)`;
- parsing, validating, converting, and calling in one expression.

Example:

```py
has_active_turn = active_turn_id is not None
has_blocking_notice = notice_registry.has_blocking_notice(session_id)

if has_blocking_notice:
    return "blocked"

if has_active_turn:
    return "running"

return "idle"
```

Do not compress this into a nested ternary. State transitions deserve room.

## 3. Keep boundaries typed

Public and cross-module functions need complete parameter and return types.

Rules:

- Do not use bare `dict[str, Any]` as the primary request/result shape for business code.
- Keep `Any` at the boundary; do not let it spread inward.
- Use `Mapping[str, Any]` only for intentionally extensible fields such as `metadata`, `source`, `content`, config values, JSON Schema, and UI schema.
- Return typed objects or explicit result classes, not dicts with optional keys that callers must guess.
- Parse external payloads at the boundary, then pass typed objects inward.

Prefer:

```py
@dataclass(frozen=True, slots=True)
class StartTurnRequest:
    session_id: str
    external_session_id: str
    content: str
    model_selection_id: str | None
    permission_selection_id: str | None
    client_message_id: str | None = None
```

Avoid:

```py
async def start_turn(params: dict[str, Any]) -> dict[str, Any]:
    ...
```

If the input starts as JSON, parse it with Pydantic or a narrow parser at the edge, then convert to a stable internal type.

## 4. Give data structures clear roles

Use this division:

```text
Pydantic model
  External input/output, API schema, config, DB/API contract.

dataclass(frozen=True, slots=True)
  Internal domain objects, runtime requests/results, typed projections.

dict / Mapping
  Open extension fields or serialization boundaries.
```

Default to immutable internal data:

- return `tuple` for result collections when mutation is not expected;
- accept `Mapping` for read-only inputs;
- do not mutate caller-owned lists/dicts;
- keep mutable caches/registries behind a class that owns them.

## 5. Separate pure functions from action functions

A function should either compute a value or perform an action. Mixing both is allowed only at orchestration boundaries, and the substeps should still be named clearly.

Pure functions:

- are usually synchronous;
- do not read or write external state;
- do not call network, filesystem, DB, environment, clock, or random APIs;
- do not mutate arguments;
- return the same output for the same input.

Good pure-function names:

```py
stable_session_id(...)
selection_from_thread_state(...)
timeline_item_from_event(...)
permission_settings_from_selection(...)
```

Action functions:

- may be async if they perform IO;
- should use verb-led names;
- should document side effects;
- should have explicit failure behavior;
- should not hide several unrelated side effects.

For action functions, include a short docstring when the side effect is not obvious:

```py
async def publish_running_state(...) -> None:
    """Publish that a turn is running.

    Side effects:
    - updates the in-memory session state cache
    - sends session.state.updated through the host client
    """
```

## 6. Design parameters explicitly

Rules:

- Do not use `*args` or `**kwargs` for business APIs.
- Do not pass business data through a generic `params` dict.
- Do not use `fn(**payload)` to tunnel parameters across layers.
- Do not use mutable default values.
- Do not use `None` for several unrelated meanings.
- Prefer keyword arguments when a call has multiple values of the same primitive type.

Allowed exceptions:

- framework or SDK callback signatures;
- test fakes/mocks;
- JSON/CLI/RPC boundary parsing;
- controlled compatibility shims with a removal plan.

Parameter count guidance:

- 1-4 simple parameters: explicit parameters are fine.
- More than 4 parameters for one business action: introduce a dataclass request.
- More than 4 parameters from unrelated concepts: split the function.

## 7. Do not hide main flow behind private helpers

Use `_private_name` sparingly.

Acceptable private functions:

- tiny file-local helpers;
- real class implementation details;
- local formatting/conversion helpers;
- helpers introduced only to keep a function readable.

Avoid private names for core lifecycle steps. If understanding the system requires reading a function, do not make it look like an unimportant `_helper`.

Prefer:

```py
async def handle_turn_completed(...):
    ...
```

or a named component:

```py
class TurnCompletionProjector:
    async def project_completed_turn(...):
        ...
```

over:

```py
async def _handle_turn_completed(...):
    ...
```

The point is not public API exposure; the point is honest names for important behavior.

## 8. Keep classes focused

A class should exist because it owns one kind of state, implements one boundary, or coordinates one coherent workflow.

Good class roles:

- `Provider`: discover, validate config, create runtime.
- `Runtime`: compose components and implement a protocol.
- `Client`: isolate an external system.
- `Reader`: read external/local state.
- `Projector`: convert events into domain/protocol objects.
- `Controller`: coordinate a user operation.
- `Registry` or `Cache`: own mutable in-memory state.
- `Store` or `Repository`: own persistence.

Danger signs:

- names like `Helper`, `Utils`, `Manager`, or `Common` for important business logic;
- a class that reads SDK data, validates config, writes server state, reduces timeline, and manages lifecycle;
- constructor dependencies that span unrelated layers;
- exposed mutable internal dictionaries/lists.

If a class needs many `_helper` methods to stay understandable, it probably contains multiple responsibilities.

## 9. Let modules encode architecture

File paths should tell the reader what layer they are in.

Prefer concrete module paths:

```text
sdk/client.py
sdk/events.py
domain/selections.py
timeline/projector.py
sessions/reader.py
turns/interrupt.py
```

Avoid dumping business logic into:

```text
utils.py
helpers.py
common.py
misc.py
manager.py
```

Layering rules:

- one module belongs to one layer;
- lower layers must not import higher layers;
- domain modules must not import server modules;
- protocol modules must not import concrete runtimes;
- SDK adapters must not import Web/server UI concerns;
- `_reference` or deprecated code must not be imported by active code.

## 10. Make side effects visible and ordered

Side effects include network calls, DB/file writes, cache mutation, state transitions, host/server notifications, background tasks, logs of business events, clock reads, random IDs, and environment reads.

For side-effect functions, make clear:

- what state is changed;
- who is notified;
- whether the action is retryable;
- whether partial side effects can remain after failure;
- why the order matters when there are multiple effects.

When order matters, encode that order in named steps. For example:

```text
publish waiting state
register pending client message
start SDK turn
bind active turn id
publish running state
consume stream
publish timeline item upserts
publish idle on terminal event
```

Do not hide this sequence inside a vague `_handle` method.

## 11. Treat errors as part of the contract

Rules:

- Do not swallow exceptions.
- Do not use `except Exception: pass`.
- Do not return `{}` as an error.
- Do not make logs the only error surface.
- Convert boundary errors into explicit exceptions, result codes, state updates, or notices.
- Keep retryable/non-retryable distinctions explicit when they matter.

Good:

```py
return RuntimeOperationResult(
    ok=False,
    code="codex_no_active_turn",
    message="Codex runtime has no active turn to interrupt.",
)
```

State-machine errors should also update visible state when appropriate:

```text
turn start failed -> SessionState.status = error
approval required -> SessionState.status = blocked + SessionNotice
interrupt has no active turn -> SessionState.status = idle + explicit result
```

## 12. Use async only for real async boundaries

Use async for network, SDK streams, WebSocket, async DB drivers, and lifecycle-owned background work.

Do not make pure conversion functions async.

Background task rules:

- every task has an owner;
- owners cancel tasks during stop/cleanup;
- task exceptions are observed;
- fire-and-forget requires a comment explaining ownership and failure handling.

## 13. Make state ownership explicit

For each piece of state, be able to answer:

- who owns it?
- can it be rebuilt?
- is it persisted?
- is it shown to UI?
- how is it corrected after failure?

General rules:

- Config belongs to the config/server layer; runtime may validate and use it but should not persist it locally unless explicitly designed.
- UI state should come from explicit state objects, not inferred from timeline accidents.
- Timeline items should be upserted; do not delete normal history items. Hide with state/metadata when needed.
- Interaction/approval/error notices belong in notice state, not ordinary chat messages.
- In-memory active operation IDs are runtime aids, not durable protocol truth.
- Sync cursors are connector-local implementation details, not user-visible truth.

## 14. Keep dicts and serialization at the edge

Allowed dict surfaces:

- JSON payloads;
- HTTP/WebSocket bodies;
- Pydantic/dataclass serialization output;
- `metadata`, `source`, `content`, config values, JSON Schema, UI Schema;
- test fixtures;
- unknown fallback diagnostics.

Do not use dicts for:

- internal business requests;
- internal business results;
- state-machine objects;
- known SDK reducer paths;
- main cross-component communication.

`model_dump()` is allowed at JSON serialization boundaries, in tests asserting wire shape, and in unknown fallback diagnostics. Do not use it as the first step of known object reduction.

## 15. Keep logs useful and safe

Logs are observability, not control flow.

Rules:

- include event name, relevant IDs, and error type;
- do not print secrets;
- do not dump large payloads unless debug-only and sanitized;
- do not replace user-visible errors with logs;
- keep high-frequency logs restrained;
- make important lifecycle logs structured enough to search.

## 16. Test architecture, not only behavior

For non-trivial Python systems, tests should guard architectural rules as well as outputs.

Useful tests include:

- protocol contract tests;
- state transition tests;
- side-effect ordering tests;
- stable ID/hash tests;
- duplicate event folding tests;
- no active imports from reference/deprecated paths;
- no generic dump for known typed reducers;
- no broad `.get(...)` probing in core business reducers;
- background task cleanup tests.

Test fixtures may use dicts, but production code should not become dict-driven just because tests are easy to write that way.

## 17. Allow exceptions only when they are isolated

An exception to these rules is acceptable when it is:

- localized to a boundary;
- named as a compatibility/fallback path;
- documented with the reason;
- covered by tests when risky;
- easy to remove later.

Example:

```py
# Fallback for unknown SDK payloads used for diagnostics only.
# Known SDK notification classes must be projected through typed branches above.
```

If an exception starts spreading into normal business code, stop and refactor the boundary.

## Review checklist

Before finishing Python work, ask:

1. Is each function clearly pure computation or a side-effect action?
2. Are side effects named and documented where non-obvious?
3. Are business APIs free of `*args`, `**kwargs`, and `**payload` tunneling?
4. Are known data shapes typed instead of dict-probed?
5. Are `.get(...)` and `model_dump()` limited to allowed boundaries?
6. Do classes and modules each have one clear responsibility?
7. Does mutable state have one owner?
8. Are errors explicit as exceptions, result codes, state updates, or notices?
9. Is async used only where IO/lifecycle requires it?
10. Did the code avoid speculative abstraction and generic shape extraction?
