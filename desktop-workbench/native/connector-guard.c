// macOS process owner for one Desktop Connector RPC launch.
#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <os/log.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
enum {
    CONTROL = 3,
    DESKTOP_GRACE_MS = 1250,
    STDIN_GRACE_MS = 250,
    TERM_GRACE_MS = 2000,
    KILL_GRACE_MS = 3000,
    CLEANUP_INCOMPLETE = 125
};

static void report(const char *event, pid_t group, const char *detail) {
    char line[256];
    int length = snprintf(line, sizeof(line), "%s %d %s\n", event, group, detail);
    if (length > 0 && (size_t)length < sizeof(line))
        (void)send(CONTROL, line, (size_t)length, MSG_DONTWAIT);
}

static pid_t parse_pid(const char *text) {
    char *end;
    errno = 0;
    long pid = strtol(text, &end, 10);
    return !errno && !*end && pid > 1 && pid <= INT_MAX ? (pid_t)pid : 0;
}

static int watch_exit(int queue, pid_t pid) {
    struct kevent event;
    EV_SET(&event, pid, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
    return kevent(queue, &event, 1, NULL, 0, NULL);
}

static bool live_in_group(pid_t pid, pid_t group) {
    struct proc_bsdinfo info;
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info) &&
        info.pbi_pgid == (uint32_t)group && info.pbi_status != SZOMB;
}

static int launch(pid_t *group, const char *cwd, char *const command[]) {
    posix_spawnattr_t attributes;
    posix_spawn_file_actions_t files;
    int error = posix_spawnattr_init(&attributes);
    if (error) return error;
    error = posix_spawn_file_actions_init(&files);
    if (error) {
        posix_spawnattr_destroy(&attributes);
        return error;
    }

    sigset_t defaults, mask;
    sigemptyset(&defaults);
    sigaddset(&defaults, SIGTERM);
    sigaddset(&defaults, SIGINT);
    sigaddset(&defaults, SIGPIPE);
    sigemptyset(&mask);
    error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP |
        POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_CLOEXEC_DEFAULT);
    if (!error) error = posix_spawnattr_setpgroup(&attributes, 0);
    if (!error) error = posix_spawnattr_setsigdefault(&attributes, &defaults);
    if (!error) error = posix_spawnattr_setsigmask(&attributes, &mask);
    for (int fd = STDIN_FILENO; fd <= STDERR_FILENO && !error; ++fd)
        error = posix_spawn_file_actions_addinherit_np(&files, fd);
    if (!error) {
        // The replacement API requires macOS 26. Desktop supports macOS 13.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        error = posix_spawn_file_actions_addchdir_np(&files, cwd);
#pragma clang diagnostic pop
    }
    if (!error) error = posix_spawn(group, command[0], &files, &attributes, command, environ);
    posix_spawn_file_actions_destroy(&files);
    posix_spawnattr_destroy(&attributes);
    return error;
}

static bool boot_id(char id[64]) {
    size_t size = 64;
    return sysctlbyname("kern.bootsessionuuid", id, &size, NULL, 0) == 0 && size > 1 && size <= 64;
}

static bool session_identity(pid_t session, char identity[128]) {
    char boot[64];
    struct proc_bsdinfo info;
    if (!boot_id(boot) || getsid(session) != session ||
        proc_pidinfo(session, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return false;
    int length = snprintf(identity, 128, "%s:%llu:%llu", boot,
        (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
    return length > 0 && length < 128;
}

static int process_snapshot(int query[], unsigned length, struct kinfo_proc **out, size_t *count) {
    size_t size = 0;
    if (sysctl(query, length, NULL, &size, NULL, 0) < 0) return -1;
    *count = 0;
    *out = NULL;
    if (!size) return 0;
    size += 8 * sizeof(struct kinfo_proc);
    struct kinfo_proc *processes = malloc(size);
    if (!processes) return -1;
    if (sysctl(query, length, processes, &size, NULL, 0) < 0) {
        free(processes);
        return -1;
    }
    *out = processes;
    *count = size / sizeof(*processes);
    return 0;
}

// One PID in the group is enough to identify its session. The process from
// the original snapshot may have exited or forked by the time we inspect it.
static int group_in_session(pid_t group, pid_t session) {
    int query[] = { CTL_KERN, KERN_PROC, KERN_PROC_PGRP, group };
    struct kinfo_proc *processes;
    size_t count;
    if (process_snapshot(query, 4, &processes, &count) < 0) return 2;
    int result = 0;
    for (size_t i = 0; i < count; ++i) {
        struct extern_proc *process = &processes[i].kp_proc;
        if (process->p_stat == SZOMB) continue;
        pid_t sid = getsid(process->p_pid);
        if (sid >= 0) { result = sid == session; break; }
        result = 2;
    }
    free(processes);
    return result;
}

static int scan_session(pid_t session) {
    int query[] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL };
    struct kinfo_proc *processes;
    size_t count;
    if (process_snapshot(query, 3, &processes, &count) < 0) return 2;
    int result = 0;
    for (size_t i = 0; i < count; ++i) {
        struct extern_proc *process = &processes[i].kp_proc;
        if (process->p_pid <= 1 || process->p_stat == SZOMB) continue;
        pid_t sid = getsid(process->p_pid);
        if (sid == session) { result = 1; break; }
        if (sid >= 0) continue;
        // The guard could have created its launch group after this snapshot.
        if (process->p_pid == session) { result = 2; continue; }
        int member = group_in_session(processes[i].kp_eproc.e_pgid, session);
        if (member == 1) { result = 1; break; }
        if (member == 2) result = 2;
    }
    free(processes);
    return result;
}

static int session_active(pid_t session, const char *identity) {
    char boot[64], current[128];
    const char *separator = strchr(identity, ':');
    if (!separator || !boot_id(boot)) return 2;
    // A prior boot or a new leader with the same SID cannot own this launch.
    if ((size_t)(separator - identity) != strlen(boot) ||
        strncmp(identity, boot, strlen(boot))) return 0;
    if (session_identity(session, current) && strcmp(identity, current)) return 0;

    // The SID remains reserved after the leader dies. Repeat if a process
    // vanished during inspection: it could have forked after the snapshot.
    for (int attempt = 0; attempt < 3; ++attempt) {
        int result = scan_session(session);
        if (result != 2) return result;
    }
    return 2;
}

// Keep the group leader waitable until cleanup finishes, so the PID cannot be
// reused as the ID of an unrelated group. Zombies do not block cleanup.
static int live_members(pid_t group) {
    int query[] = { CTL_KERN, KERN_PROC, KERN_PROC_PGRP, group };
    struct kinfo_proc *processes;
    size_t count;
    if (process_snapshot(query, 4, &processes, &count) < 0) return -1;
    int live = 0;
    for (size_t i = 0; i < count; ++i)
        if (processes[i].kp_proc.p_stat != SZOMB) ++live;
    free(processes);
    return live;
}

static void signal_group(pid_t group, int signum) {
    if (kill(-group, signum) < 0 && errno != ESRCH)
        report("signal-error", group, strerror(errno));
}

static long long now_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int reap_group(pid_t group, const char *reason) {
    report("stopping", group, reason);
    // EOF lets the Connector finish its own shutdown. The backend closes
    // stdin before requesting a stop, and the kernel closes it on backend exit.
    const bool wait_for_stdin = !strcmp(reason, "stop-requested") || !strcmp(reason, "backend-disconnected");
    const long long term_at = now_ms() + (wait_for_stdin ? STDIN_GRACE_MS : 0);
    bool terminated = false, killed = false;
    long long kill_at = 0, finish_at = 0;
    for (;;) {
        int live = live_members(group);
        if (live == 0) break;
        long long now = now_ms();
        if (!terminated && now >= term_at) {
            signal_group(group, SIGTERM);
            terminated = true;
            kill_at = now + TERM_GRACE_MS;
        }
        if (terminated && !killed && now >= kill_at) {
            signal_group(group, SIGKILL);
            killed = true;
            finish_at = now + KILL_GRACE_MS;
        }
        if (killed && now >= finish_at) {
            const char *detail = live < 0 ? "inspection-failed" : "live-members";
            report("blocked", group, detail);
            os_log_error(OS_LOG_DEFAULT,
                "Agents Anywhere Connector group %d cleanup unconfirmed (%{public}s, %{public}s)",
                group, reason, detail);
            // The recorded session protects the environment after we exit.
            return CLEANUP_INCOMPLETE;
        }
        struct timespec interval = { 0, killed ? 100000000 : 50000000 };
        nanosleep(&interval, NULL);
    }

    int status = 0;
    pid_t reaped;
    do { reaped = waitpid(group, &status, 0); } while (reaped < 0 && errno == EINTR);
    report("clean", group, reason);
    if (reaped < 0) return 1;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

static const char *read_commands(int queue, pid_t *group, const char *cwd,
        char *const command[], char line[64], size_t *used) {
    char bytes[128];
    ssize_t count = read(CONTROL, bytes, sizeof(bytes));
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) return NULL;
    if (count <= 0) return "backend-disconnected";

    for (ssize_t i = 0; i < count; ++i) {
        if (bytes[i] != '\n') {
            if (*used == 63) return "invalid-command";
            line[(*used)++] = bytes[i];
            continue;
        }
        line[*used] = '\0';
        *used = 0;

        if (!strcmp(line, "stop")) return "stop-requested";
        if (!strcmp(line, "start") && !*group) {
            int error = launch(group, cwd, command);
            if (error) {
                *group = 0;
                report("launch-error", 0, strerror(error));
                return "launch-failed";
            }
            close(STDIN_FILENO);
            close(STDOUT_FILENO);
            close(STDERR_FILENO);
            if (watch_exit(queue, *group) < 0) return "launcher-exited";
        } else if (!strncmp(line, "watch ", 6) && *group) {
            pid_t connector = parse_pid(line + 6);
            if (!connector || !live_in_group(connector, *group)) return "connector-unavailable";
            // Check again after registration to cover a concurrent exit or reparent.
            if (connector != *group &&
                (watch_exit(queue, connector) < 0 || !live_in_group(connector, *group)))
                return "connector-exited";
        } else {
            return "invalid-command";
        }
    }
    return NULL;
}

int main(int argc, char *argv[]) {
    if (argc == 4 && !strcmp(argv[1], "--session-active")) {
        pid_t session = parse_pid(argv[2]);
        return session ? session_active(session, argv[3]) : 2;
    }

    // argv contains Main's PID, the Connector's cwd and its original argv.
    // Only the private control socket may authorize launch.
    pid_t desktop = argc >= 4 ? parse_pid(argv[1]) : 0;
    int no_sigpipe = 1;
    if (setsockopt(CONTROL, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe)) < 0)
        return 1;
    const char *reason = "desktop-exited";
    int queue = kqueue();
    pid_t group = 0;

    if (desktop && queue >= 0 && watch_exit(queue, desktop) == 0) {
        signal(SIGTERM, SIG_IGN);
        signal(SIGINT, SIG_IGN);
        struct kevent events[3];
        EV_SET(&events[0], CONTROL, EVFILT_READ, EV_ADD, 0, 0, NULL);
        EV_SET(&events[1], SIGTERM, EVFILT_SIGNAL, EV_ADD, 0, 0, NULL);
        EV_SET(&events[2], SIGINT, EVFILT_SIGNAL, EV_ADD, 0, 0, NULL);
        char identity[128];
        if (kevent(queue, events, 3, NULL, 0, NULL) == 0 && session_identity(getpid(), identity)) {
            report("session", getpid(), identity);
            char line[64];
            size_t used = 0;
            long long desktop_deadline = 0;
            for (;;) {
                struct timespec timeout;
                if (desktop_deadline) {
                    long long left = desktop_deadline - now_ms();
                    if (left <= 0) { reason = "desktop-exited"; break; }
                    timeout = (struct timespec){ left / 1000, left % 1000 * 1000000 };
                }
                struct kevent event;
                int result = kevent(queue, NULL, 0, &event, 1, desktop_deadline ? &timeout : NULL);
                if (result < 0 && errno == EINTR) continue;
                if (result <= 0) { reason = result == 0 ? "desktop-exited" : "watch-failed"; break; }
                if (event.filter == EVFILT_PROC) {
                    if (event.ident == (uintptr_t)desktop && group) {
                        // A live backend gets its existing connector.stop budget.
                        desktop_deadline = now_ms() + DESKTOP_GRACE_MS;
                        continue;
                    }
                    reason = event.ident == (uintptr_t)desktop ? "desktop-exited" :
                        event.ident == (uintptr_t)group ? "launcher-exited" : "connector-exited";
                    break;
                }
                if (event.filter == EVFILT_SIGNAL) { reason = "stop-requested"; break; }
                reason = read_commands(queue, &group, argv[2], argv + 3, line, &used);
                if (reason) break;
            }
        } else {
            reason = "watch-failed";
        }
    }
    if (queue >= 0) close(queue);
    if (group) return reap_group(group, reason);
    report("clean", 0, reason);
    return 1;
}
