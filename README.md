# obsync

A three-pane, drag-and-drop GUI for [mutagen](https://mutagen.io) sync sessions.
Built for the case where notes live on your laptop but the work happens on a
remote box — an HPC cluster, a GPU server, a VPS.

[中文文档](README.zh-CN.md)

```
 hosts │   remote        │    links    │    local      │
       │  working dir ───┼──→ drop ←───┼── working dir │
```

Both file panes are symmetric. Whatever directory a pane is showing is that
side's **working directory**. Drag a folder out of either pane and its
counterpart is created under the *other* pane's working directory, then the two
stay in sync — bidirectionally, continuously, with conflict detection.

No Electron, no build step, no npm dependencies. A ~900-line Node server using
only the standard library, plus a single-page frontend.

## Why not just rsync / scp / a git repo

Those are transfers; you run them. mutagen is a daemon: it watches both ends and
propagates changes as they happen. What mutagen doesn't have is a way to *see*
your sessions or make one without typing two absolute paths. That's this.

## Install

Requires macOS, [Node.js](https://nodejs.org) 18+, and
[mutagen](https://mutagen.io/documentation/introduction/installation) 0.18+.

```sh
git clone https://github.com/Jiangnan0522/obsync.git
cd obsync
./install.sh
```

`install.sh` verifies the dependencies, writes a starter config to
`~/.obsync/config.json`, installs an `obsync` command into `~/.local/bin`, and
optionally registers a LaunchAgent so the server starts at login.

Then:

```sh
obsync              # start the server (if needed) and open the UI
obsync status       # is it running? is it managed by launchd?
obsync stop | restart | log | path
```

Add your first host from the sidebar — obsync reads `~/.ssh/config` (following
`Include`) and offers the aliases it finds.

**Ports, keys, ProxyJump and friends belong in `~/.ssh/config`.** obsync shells
out to the system `ssh`, so everything you configure there is inherited. Key
auth must work without a prompt: the sync daemon runs in the background and
cannot answer a password challenge.

## Using it

- **Create a link** — drag a folder from either pane into the middle.
  Dragging a *local* folder pushes it up; dragging a *remote* folder pulls it
  down. While dragging, the middle pane shows the exact destination path.
- **Change working directory** — click into folders, or use the breadcrumbs.
  "Open…" in a pane header accepts any path; it is added to that side's
  allow-list and persisted. Both working directories are restored next launch.
- **Folder tags** — `synced` means the folder *is* a link root. `contains N`
  (dashed) means a link root lives somewhere beneath it.
- **Direction badge** — each link card says where its content originally came
  from: `local → remote`, `remote → local`, or `merged` when both sides already
  had content and no direction is truthful.
- **Destination prefix** — the side a sync *creates* is named
  `[from:<origin>] <name>`, so it is obvious it is not hand-made. Round-tripping
  never nests the prefix.
- **Disconnect** — drag a card to the trash zone, or click `✕`. Both sides are
  kept by default; a checkbox offers to delete the side the sync created.

## Safety

Sync tools delete files. These are the rules this one follows.

**Terminate before deleting, and verify it terminated.** Deleting a destination
while its session is live would propagate the deletion to the *source*. So:
terminate → re-query and confirm the session is really gone → only then touch
files. If that confirmation fails, the delete is abandoned.

**Only the created side is deletable.** Which side that is comes from the
`obsync-src` label written at creation. `merged` links offer no delete at all:
both sides predate the sync, so neither is a copy. Path validation runs *before*
teardown, so a rejected request never leaves you with a torn-down session.

**Local deletes go to the Trash.** Remote deletes are `rm -rf` and say so. If
Trash is on a different volume (`rename` cannot cross volumes) the delete is
refused rather than silently downgraded to an unrecoverable one.

**Roots are an allow-list.** Every path must sit inside a directory you opened.
This is not just fat-finger protection: any page in your browser can POST to
`127.0.0.1`. A JSON content type forces a CORS preflight that never gets
answered, but `text/plain` carrying a JSON body is a "simple request" and sails
through — so state-changing requests also check `Origin`.

**No shell string building.** Subprocesses are `execFile(cmd, [args])`. The one
place a remote shell must interpret a path, it is single-quote escaped. Folder
names with spaces, `&`, CJK and emoji round-trip intact.

## Notes from building it

**mutagen is the database.** There is no state file. Sessions are labeled
`obsync=true`, plus `obsync-host` and `obsync-src`, and the UI lists them with
`--label-selector`. Kill the server, reboot — syncing continues, and sessions
you made by hand with the mutagen CLI are never touched.

**Session names are hashes.** mutagen names must match
`[A-Za-z0-9][-A-Za-z0-9_.]*`, but real folders are called `📊 读书笔记`. Names
are `obsync-<10 hex>` derived from the paths; the display name is read back from
the path.

**Remote watching is polling, and that's correct.** The local end uses FSEvents
and propagates in ~2s. A network filesystem can't be trusted to deliver inotify
events for writes made by another node, so mutagen polls the remote (default
10s; `remotePollSeconds` sets it).

**`find -H`, always.** Cluster homes are very often symlinks
(`/users/x -> ../../volumes/...`) and plain `find` will not traverse the
starting point, returning nothing. `-H` dereferences the start only. Remote
commands also `test -d` first and emit a sentinel on failure — otherwise every
error renders as "empty directory".

**Never share an ssh ControlMaster with mutagen.** Multiplexing makes obsync's
own directory listings ~100x faster, so it is tempting to turn it on in
`~/.ssh/config` for your sync hosts. Don't: mutagen holds one ssh channel per
sync session *forever*, so the master never goes idle and `ControlPersist`
never recycles it, while channels leaked by unclean disconnects accumulate
until the server hits `MaxSessions` and refuses every new one. The only visible
symptom is sessions stuck in "connecting" — and a manual `ssh` to the same host
still succeeds, because it rides an already-open channel. obsync multiplexes
its own calls on a private socket under `~/.obsync/` and leaves mutagen's
connections direct.

**Size probes exit early.** Before creating a link, the source is measured and
anything over the threshold (5 MB / 2000 files by default) prompts. The probe
stops the instant it crosses the limit — `awk` exits, `find` takes SIGPIPE — so
it costs the same on a 5 MB folder as on a 188 GB one. Measured: 0.12s.

**Overlapping roots are flagged.** If `A/` is synced and you also sync `A/B/`,
two sessions manage the same files and echo each other's writes. Dragging a
folder that nests with an existing link warns you.

## Configuration — `~/.obsync/config.json`

| Key | Meaning |
|---|---|
| `port` | HTTP port, loopback only (default 7777) |
| `localRoots[]` | Local directories obsync may touch; "Open…" appends |
| `hosts[]` | `alias` must resolve via `~/.ssh/config` (or be `user@host`); `remoteRoots[]` is its allow-list |
| `syncMode` | `two-way-safe` (default), `one-way-safe`, … |
| `ignore[]` | mutagen ignore patterns |
| `remotePollSeconds` | Remote poll interval (default 10) |
| `destPrefix` | Destination name template, default `"[from:{name}] "`; `""` disables |
| `localLabel` | What the local side is called in that prefix |
| `warnSizeMB` / `warnFileCount` | Size-warning thresholds; `0` disables |

`lastLocalDir` and `hosts[].lastRemoteDir` are written automatically.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "disconnected" on a card | SSH is failing. If your cluster uses periodic MFA, re-authenticate in its portal; the session recovers on its own |
| "N conflicts" | Both sides edited the same file. `mutagen sync list --long <name>` |
| Stuck "scanning" | The folder is too large. New links warn about this; existing ones don't get re-checked |
| File counts differ | Check whether the difference is in `ignore` (`.obsidian/`, `.git/`, …). Compare names with `find . -type f`, not counts |
| A link vanished | No data is lost; both sides keep their files. Drag it back — you'll get the merge prompt |
| Links stuck "connecting", but `ssh <host>` works fine | An ssh ControlMaster is out of channels. Remove `ControlMaster` from that host's `~/.ssh/config` block and delete its socket; obsync does its own multiplexing |
| UI won't open | `obsync log` |

## License

MIT
