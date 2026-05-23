# Auto-sync

Auto-sync schedules a background push after memory hooks write raw observations. It is designed for creator machines: the hook records the observation, spawns a detached worker, and exits without waiting for the network.

## Trigger Model

`PostToolUse` and `Stop`/`SessionEnd` hooks call `scheduleAutoPush()` after appending to the raw session file. The scheduler writes a small pending file at:

```text
~/.memory/.auto-push-pending
```

Then it spawns:

```text
node auto-push-worker.mjs <memoryRoot> <token>
```

The child is detached with ignored stdio, so the agent hook is never blocked by a git push.

On the first schedule call in a git-backed memory root, the scheduler also adds `.auto-push-pending` and `auto-sync.log` to `.git/info/exclude`. Those local coordination files should not make the memory repo dirty.

## Debounce Model

Every schedule call writes a new random token. The worker sleeps for the debounce window, then re-reads `.auto-push-pending`. If the token no longer matches, a newer worker has taken over and the old worker exits silently.

Default debounce window:

```text
5000ms
```

If ten hooks fire in one second, ten workers may exist briefly, but only the newest token performs the push.

## Worker Model

When the token still matches, the worker runs the same conflict-aware sync path as `memory sync`. On success, it deletes `.auto-push-pending`, writes a success line to `auto-sync.log`, and updates `.sync-state.json`.

```text
~/.memory/auto-sync.log
~/.memory/.sync-state.json
```

## Failure Modes

**Offline or VPS unreachable**

Offline is normal. The worker logs an informational failure line to `auto-sync.log`, updates `pending_push_count`, deletes the pending file, and exits `0`. It does not write to `errors.log`.

### When wiki/ is dirty

If you have uncommitted edits in `wiki/` (or `crystals/`, or top-level files), auto-sync deliberately skips the push:

```text
[<iso>] auto-push skipped: non-raw dirty files present (run `memory sync` after committing: wiki/projects/foo.md)
```

This preserves in-progress wiki edits - you commit when you're ready, not when auto-sync decides. Raw observations under `raw/` are different: append-only firehose data, so auto-sync auto-commits them with a `chore: auto-capture <N> raw observation file(s)` message before pushing.

The auto-commit happens inside the post-hook worker, after the debounce window. One commit per debounce cycle (5+ seconds), not one per hook fire.

**Conflict**

Conflicts are serious and require manual resolution. The worker follows the Slice 3 sync behavior: it records conflict files in `.sync-state.json`, writes to `errors.log`, logs the conflict in `auto-sync.log`, and exits. Future automatic pushes refuse until the user resolves the conflict state.

**Crashed worker**

If a worker crashes before deleting `.auto-push-pending`, the next hook write schedules a new token and worker. The stale token comparison makes older workers harmless.

## Disable

Set this environment variable in the agent environment to disable scheduling:

```powershell
$env:MEMORY_AUTO_PUSH = "0"
```

With `MEMORY_AUTO_PUSH=0`, hooks still write raw files, but no worker is spawned.
