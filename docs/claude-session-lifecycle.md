# Claude session process lifecycle

The Connector owns at most one live Claude SDK connection (and its CLI process)
per active AA session. A completed model reply is not the end of that connection:
subsequent user turns reuse it while it remains open. Different AA sessions do
not share a CLI process, even when they use the same project directory. An
inactive historical session is not reopened merely because it exists.

## Reclamation

After a turn completes, an ordinary streaming connection becomes eligible for
reclamation after `idleTimeoutSeconds` (default 600, configurable from 60 to
86400 seconds). A new turn cancels and resets that timer. At expiry, the
Connector checks the same session and connection again under the session lock
before closing it; queued input or an active execution prevents eviction.
Clients without a continuous receive stream retain their one-shot behavior.

Native `task_started` and `task_progress` events mark background work active.
Terminal `task_updated` or `task_notification` events clear it. The connection
is not reclaimed while any observed background task is active, even after the
main reply ends. An unconfirmed task is not assumed complete. Model or
permission changes do not force-close a connection with active background
work; the next turn can use the new selection after that work completes.

Observed `CronCreate` and `CronList` jobs keep the process alive regardless of
the idle timeout. The SDK's `ScheduleWakeup` result and Stop hook also tell AA
when to keep the process alive for a dynamic `/loop` wakeup. That protection
ends when Claude reports cancellation or no remaining wakeups, or when the
observed deadline and a short grace period pass. Only Cron task IDs go into
the restart registry. A process-local wakeup is lost if the process exits.
Reconciliation waits until native background work and dynamic wakeups are no
longer pending, so the maintenance request doesn't interfere with them.

Runtime shutdown and transport failure close the owned connection. A cleanly
interrupted turn can leave it available, while an input that cannot be
individually retracted may require closing it. After process loss, ordinary
turns can resume from the native session ID. Startup reconnects only sessions
registered with observed Cron jobs.

On a resumed connection, AA matches the first user reply by its native
message ID. If Claude also injects a task notification from the previous
process, the prompt hook identifies the actual user input. If the turn ends
without a reply or tool work, AA reports an error and leaves the next action
to the user. In-flight background work is not automatically replayed.
