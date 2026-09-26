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

Future wakeups are a separate constraint: observed `CronCreate`/`CronList`
jobs keep the process alive regardless of idle timeout, and a successful
empty reconciliation removes that reason to retain it. Failed reconciliation
does not mean an empty job list. Reconciliation waits for native background
work to finish so its maintenance-only tool restrictions do not interrupt that
work. Runtime shutdown and transport failure close
the owned connection; a cleanly interrupted turn can leave it available, while
an input that cannot be individually retracted may require closing it.
After process loss, ordinary turns can resume from the native session ID;
in-flight background work is not automatically replayed. Startup reconnects
only sessions registered with observed scheduled jobs.

## Pending validation

This lifecycle change has local automated coverage but is **pending real
Connector/Claude CLI validation**. Verify a no-Cron background task completes
after its initiating reply, a follow-up user prompt reuses the same process,
the configured idle timeout reclaims it, and a scheduled job fires on time
without a new prompt. Also repeat #122 (legacy `ScheduleWakeup`) and #123
(background notification racing a real user message) against the deployed
SDK/CLI; neither issue is closed by the presence of an idle timer. Durable
task ownership across multiple Connector processes and recovery of interrupted
background work are not guaranteed.
