# Architecture

## High-Signal Integration Examples

This is an examples table, not the authoritative platform matrix. See
`docs/compatibility-matrix.md` for the current complete status, proof
requirements, and support level for each platform.

| Platform | Hooks (passive) | MCP (active) |
|---|---|---|
| **Claude Code** | yes - plugin hooks | yes - plugin MCP server |
| **Codex** | yes - local config hooks | yes - local MCP server |
| **Antigravity** | partial - live-capture plugin | yes - local MCP server |
| **OpenCode** | selected plugin event capture implemented; live smoke pending | yes - `opencode.json` local MCP config; live smoke pending |
| **OpenClaw** | no v1 hooks; gateway-level HTTP hooks are skipped | yes - OpenClaw MCP config only |

## Backup, restore, and erasure boundary

The Git-backed markdown vault is canonical. SQLite search files, vectors, root `index.md`, and generation markers are derived state. A live erase publishes an invalidating generation before its first deletion, removes attributable live data, rebuilds the index from the remaining vault, and publishes a ready generation only after validation. Readers remain quiesced while recovery is incomplete.

`memory backup create` writes an archive with a complete SHA-256 manifest and Git identity, verifies every extracted file, and runs strict full-object Git integrity checks. `memory backup drill` restores into a disposable workspace, rebuilds the index, proves a canary search, deletes the workspace, and emits signed restore-drill evidence. Same-device versus different-device placement is reported; off-host durability is not inferred.

`memory forget` defaults to a non-mutating inventory. `--apply` affects only itemized live raw files and attributable derived material; Git history, backups, archives, and crystals are retained. The success state is `live-erased/history-retained`. For a Git-backed vault, a signed prepared journal exists before mutation, and the signed receipt is stored outside the protected repository so a same-selector retry can finish evidence persistence safely.

`memory forget --purge-history` is the separately guarded local rewrite. It requires the exact live selection, fresh signed live-erase and restore-drill evidence, explicit local branch refs, a clean disposable clone, and the exact consequence phrase printed by its plan. It updates only the itemized local refs after post-rewrite validation. Remotes, other clones, reflogs, unreachable objects, and backups remain; pushing, reflog expiry, garbage collection, and backup destruction are separate operator decisions.

Lifecycle evidence uses HMAC-SHA256 with a device-local key outside the vault. Signatures detect later payload edits but are not an external timestamp, remote attestation, or proof that a copied key remained secret.
