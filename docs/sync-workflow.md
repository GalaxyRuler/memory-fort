# Sync workflow

`memory sync` coordinates the local `~/.memory/` git repository with the VPS remote configured by `memory sync-bootstrap`. It fetches `vps/main`, refuses unsafe states, rebases when the VPS is ahead, pushes when the local machine is ahead, and records conflict state in `~/.memory/.sync-state.json`.

## Commands

- `memory sync` — fetch, pull-rebase if needed, then push local commits.
- `memory pull` — fetch and pull-rebase only. Use this when you want to update the local machine without publishing local commits yet.
- `memory push` — push local commits. If the push is rejected because the VPS moved first, it does one pull-rebase and retries once.

## States

- `clean` — working tree clean and local `main` matches `vps/main`.
- `dirty` — uncommitted changes exist. Commit or stash before syncing.
- `local-ahead` — local has commits the VPS does not have.
- `remote-ahead` — VPS has commits the local machine does not have.
- `divergent` — both sides have new commits.
- `conflicted` — `.sync-state.json` records unresolved conflict files from a failed rebase.

## Conflict Flow

When a rebase conflict happens, sync aborts the rebase, records the conflicted paths, writes a line to `errors.log`, and exits with code `3`.

```text
Sync paused: <N> files have unresolved conflicts.
Conflict files:
  - wiki/projects/foo.md
  - wiki/decisions/bar.md
To resolve:
  1. Edit each file; remove conflict markers (<<<<<<<, =======, >>>>>>>); keep the content you want
  2. Run: git -C <memoryRoot> add <file>; git -C <memoryRoot> commit -m "resolve conflict in <file>"
  3. Clear the conflict state: edit ~/.memory/.sync-state.json and set conflicts_pending: 0 and conflict_files: []
  4. Re-run: memory sync
```

Conflicts are never auto-resolved.

## Exit Codes

- `0` — success, including clean no-op.
- `1` — internal error, git failure, or network failure.
- `2` — dirty worktree.
- `3` — conflict pending or rebase produced conflicts.

## Examples

Clean no-op:

```powershell
node dist/cli.mjs sync
```

```text
Sync clean. No changes to push or pull.
```

Push local commits:

```powershell
node dist/cli.mjs sync
```

```text
Pushed local commits to vps/main.
```

Pull only:

```powershell
node dist/cli.mjs pull
```

```text
Pulled remote commits from vps/main.
```

Retry after a push race:

```text
Push rejected; rebased and retried successfully.
```

## Troubleshooting

Look first at:

- `~/.memory/errors.log`
- `~/.memory/.sync-state.json`
- `git -C ~/.memory status`

`memory stats` will surface pending sync state in a later Phase 3 slice.

`memory sync`, `memory pull`, and `memory push` add `.sync-state.json` to `.git/info/exclude` on first run. That keeps local runtime sync state out of commits without changing the tracked `.gitignore`.

```text
.sync-state.json
```

## Raw Observation Privacy

`raw/` is tracked in git for Path 2 sync, so raw observations can move between creator machines and the VPS dashboard can report the same raw corpus the local machine sees. These files contain unfiltered hook observations. That is acceptable for this personal, Tailscale-only deployment, but the VPS git history will retain anything committed there. If a credential, token, or private key appears in a raw file, rotate that secret rather than relying on later deletion from the working tree.
