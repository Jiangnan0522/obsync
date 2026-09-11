#!/usr/bin/env node
'use strict';

// obsync — a three-pane GUI over mutagen sync sessions.
// Zero npm dependencies: Node stdlib only.
//
// Both panes are symmetric: each shows a "working directory" the user picked by
// browsing. Dragging a folder out of either pane creates a sync link whose
// counterpart lands under the *other* pane's working directory.

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const posix = path.posix;
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.obsync', 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Every session we create carries this label, so we never touch sessions the
// user made by hand with the mutagen CLI.
const OWNER_LABEL = 'obsync';
const HOST_LABEL = 'obsync-host';
// Which side the content came from when the link was made. A link created by
// merging two populated folders has no honest direction, hence 'merge'.
const SRC_LABEL = 'obsync-src';
// Sentinel a remote command prints when its target is not a readable directory.
const MISSING = '__obsync_missing__';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

// path.posix.normalize() keeps a trailing slash, which breaks every
// `startsWith(root + '/')` containment check below. Strip it here so a root
// typed as "/a/b/" behaves exactly like "/a/b" (shell completion adds these).
function normRemote(p) {
  const n = posix.normalize(String(p).trim());
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // Roots are the user's own allowlist of places obsync may touch. They start
  // as whatever was configured and grow as the user opens new working dirs.
  cfg.localRoots = (cfg.localRoots || [cfg.vaultRoot])
    .filter(Boolean)
    .map((p) => path.resolve(expandTilde(p)));

  cfg.hosts = (cfg.hosts || []).map((h) => ({
    ...h,
    remoteRoots: (h.remoteRoots || [h.remoteBase]).filter(Boolean).map(normRemote),
  }));

  return cfg;
}

function saveConfig(cfg) {
  const out = {
    port: cfg.port,
    localRoots: cfg.localRoots,
    lastLocalDir: cfg.lastLocalDir,
    syncMode: cfg.syncMode,
    remotePollSeconds: cfg.remotePollSeconds,
    destPrefix: cfg.destPrefix,
    localLabel: cfg.localLabel,
    warnSizeMB: cfg.warnSizeMB,
    warnFileCount: cfg.warnFileCount,
    ignore: cfg.ignore,
    hosts: cfg.hosts.map((h) => ({
      alias: h.alias,
      label: h.label,
      remoteRoots: h.remoteRoots,
      lastRemoteDir: h.lastRemoteDir,
    })),
  };
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH); // atomic: never leave a truncated config
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

// Quote a string for safe interpolation into a remote POSIX shell command.
function shq(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

// ---------------------------------------------------------------------------
// path containment — a path must sit inside one of the user's roots
// ---------------------------------------------------------------------------

function within(child, parent, sep) {
  return child === parent || child.startsWith(parent + sep);
}

function resolveLocal(cfg, p) {
  const c = path.resolve(expandTilde(p));
  if (!cfg.localRoots.some((r) => within(c, r, path.sep))) {
    throw new HttpError(403, `本地路径不在任何已打开的根目录内：${c}`);
  }
  return c;
}

function resolveRemote(host, p) {
  const c = normRemote(p);
  if (!host.remoteRoots.some((r) => within(c, r, '/'))) {
    throw new HttpError(403, `远端路径不在任何已打开的根目录内：${c}`);
  }
  return c;
}

function hostOf(cfg, alias) {
  const h = cfg.hosts.find((x) => x.alias === alias);
  if (!h) throw new HttpError(400, `未知主机：${alias}`);
  return h;
}

// The root that contains a path, so the UI can render breadcrumbs from it.
function rootFor(p, roots, sep) {
  const hits = roots.filter((r) => within(p, r, sep));
  return hits.sort((a, b) => b.length - a.length)[0] || roots[0];
}

// ---------------------------------------------------------------------------
// mutagen
// ---------------------------------------------------------------------------

async function listSessions() {
  const { stdout } = await run('mutagen', [
    'sync', 'list',
    '--label-selector', `${OWNER_LABEL}=true`,
    '--template', '{{json .}}',
  ]);
  return JSON.parse(stdout || '[]').map(normaliseSession);
}

function normaliseSession(s) {
  const alpha = s.alpha || {};
  const beta = s.beta || {};
  return {
    id: s.identifier,
    name: s.name,
    host: (s.labels || {})[HOST_LABEL] || beta.host || '',
    origin: (s.labels || {})[SRC_LABEL] || '',
    localPath: alpha.path || '',
    localName: path.basename(alpha.path || ''),
    remotePath: beta.path || '',
    remoteName: posix.basename(beta.path || ''),
    status: s.paused ? 'paused' : (s.status || 'unknown'),
    paused: !!s.paused,
    alphaConnected: alpha.connected !== false,
    betaConnected: beta.connected !== false,
    conflicts: (s.conflicts || []).length,
    problems:
      (s.alphaProblems || []).length +
      (s.betaProblems || []).length +
      (s.alphaGlobalProblems || []).length +
      (s.betaGlobalProblems || []).length,
    successfulCycles: s.successfulCycles || 0,
    creationTime: s.creationTime,
  };
}

// mutagen session names must match [A-Za-z0-9][-A-Za-z0-9_.]*[A-Za-z0-9].
// Folders here are Chinese / emoji / spaced, so we derive a stable ASCII name
// from a hash and let the UI show the real name (read back from the path).
function sessionName(host, localPath, remotePath) {
  const h = crypto.createHash('sha256')
    .update([host, localPath, remotePath].join('\0'))
    .digest('hex').slice(0, 10);
  return `obsync-${h}`;
}

async function remoteIsDir(alias, p) {
  const { stdout } = await run('ssh', ['-o', 'BatchMode=yes', alias,
    `test -d ${shq(p)} && echo yes || echo no`]);
  return stdout.trim().endsWith('yes');
}

// `source` says which side already holds the content; the other side is created
// empty and mutagen fills it in on the first sync cycle.
// The caller gives the dragged folder and the pane it was dropped toward; the
// destination path (name included) is derived here, so the naming rule lives in
// exactly one place.
async function createLink(cfg, { hostAlias, source, sourcePath, destDir, confirmed }) {
  const host = hostOf(cfg, hostAlias);
  if (source !== 'local' && source !== 'remote') {
    throw new HttpError(400, 'source 必须是 local 或 remote');
  }
  if (!sourcePath || !destDir) throw new HttpError(400, '缺少 sourcePath 或 destDir');

  let local, remote;
  if (source === 'local') {
    local = resolveLocal(cfg, sourcePath);
    remote = resolveRemote(host, posix.join(destDir, destName(cfg, host, source, path.basename(local))));
  } else {
    remote = resolveRemote(host, sourcePath);
    local = resolveLocal(cfg, path.join(destDir, destName(cfg, host, source, posix.basename(remote))));
  }

  const localSt = await fsp.stat(local).catch(() => null);
  const localExists = !!localSt;
  const remoteExists = await remoteIsDir(hostAlias, remote);

  if (source === 'local') {
    if (!localSt || !localSt.isDirectory()) throw new HttpError(400, '本地路径不是一个文件夹');
  } else if (!remoteExists) {
    throw new HttpError(400, '远端路径不是一个文件夹');
  }

  const name = sessionName(hostAlias, local, remote);
  const existing = await listSessions();
  if (existing.some((s) => s.name === name)) throw new HttpError(409, '这条链接已经存在');
  if (existing.some((s) => s.localPath === local)) throw new HttpError(409, '这个本地文件夹已经在同步了');
  if (existing.some((s) => s.remotePath === remote && s.host === hostAlias)) {
    throw new HttpError(409, '这个远端文件夹已经在同步了');
  }

  // Everything the user should see before committing, gathered into one
  // dialog rather than a chain of them.
  const warnings = [];

  // Both sides already hold content: the normal shape of *re*-linking a pair
  // that was synced before. mutagen unions the trees and flags differing files.
  if (localExists && remoteExists) warnings.push({ type: 'both-exist' });

  const overlapping = existing.filter((s) =>
    nests(s.localPath, local, path.sep) ||
    (s.host === hostAlias && nests(s.remotePath, remote, '/')));
  if (overlapping.length) {
    warnings.push({ type: 'overlap', names: overlapping.map((s) => s.localName) });
  }

  const limit = Math.round((cfg.warnSizeMB ?? 5) * 1024 * 1024);
  const maxFiles = cfg.warnFileCount ?? 2000;
  if (limit > 0) {
    const probe = source === 'local'
      ? await probeLocalSize(cfg, local, limit, maxFiles)
      : await probeRemoteSize(cfg, hostAlias, remote, limit, maxFiles);
    if (probe.over) warnings.push({ type: 'large', ...probe, limit, maxFiles });
  }

  if (warnings.length && !confirmed) {
    throw new HttpError(409, JSON.stringify({
      code: 'needs-confirm', warnings, localPath: local, remotePath: remote,
    }));
  }

  // Create the empty destination ourselves so permission/quota failures surface
  // as a clean message instead of a broken session.
  const createdRemote = !remoteExists;
  const createdLocal = !localExists;
  if (createdRemote) await run('ssh', ['-o', 'BatchMode=yes', hostAlias, `mkdir -p -- ${shq(remote)}`]);
  if (createdLocal) await fsp.mkdir(local, { recursive: true });

  // Both sides already had content, so neither direction is the truth.
  const origin = localExists && remoteExists ? 'merge' : source;

  const args = ['sync', 'create', '--name', name,
    '--label', `${OWNER_LABEL}=true`,
    '--label', `${HOST_LABEL}=${hostAlias}`,
    '--label', `${SRC_LABEL}=${origin}`,
    '--mode', cfg.syncMode || 'two-way-safe',
    // The remote is a network filesystem where inotify is unreliable, so
    // mutagen polls it. Default is 10s; shorten it so notes written on the
    // cluster show up in Obsidian sooner.
    '--watch-polling-interval-beta', String(cfg.remotePollSeconds || 10),
  ];
  for (const pat of cfg.ignore || []) args.push('--ignore', pat);
  args.push(local, `${hostAlias}:${remote}`);

  try {
    await run('mutagen', args);
  } catch (err) {
    // Roll back the empty directory we just made, so a failed drop leaves no trace.
    if (createdLocal) await fsp.rmdir(local).catch(() => {});
    if (createdRemote) await run('ssh', ['-o','BatchMode=yes', hostAlias, `rmdir -- ${shq(remote)}`]).catch(() => {});
    throw err;
  }
  return { name, localPath: local, remotePath: remote };
}

async function sessionAction(name, action) {
  const sessions = await listSessions();
  if (!sessions.some((x) => x.name === name)) throw new HttpError(404, '没有这条 obsync 链接');
  await run('mutagen', ['sync', action, name]);
}





// Two sessions whose roots nest inside one another both manage the same files,
// so each sees the other's writes and echoes them back.
function nests(a, b, sep) {
  return a !== b && (a.startsWith(b + sep) || b.startsWith(a + sep));
}

// ---------------------------------------------------------------------------
// terminate (optionally removing the folder the sync created)
// ---------------------------------------------------------------------------

// Which side, if any, was created by the sync and is therefore safe to remove.
// 'merge' links had content on both sides before syncing: neither side is a
// copy, so neither may be deleted.
function destinationOf(cfg, s) {
  if (s.origin === 'local') return { side: 'remote', path: s.remotePath, host: s.host };
  if (s.origin === 'remote') return { side: 'local', path: s.localPath };
  return null;
}

function assertDeletable(cfg, dest) {
  if (dest.side === 'local') {
    const p = resolveLocal(cfg, dest.path); // throws if outside every root
    if (cfg.localRoots.includes(p)) throw new HttpError(400, '拒绝删除根目录本身');
    if (p.split(path.sep).filter(Boolean).length < 3) throw new HttpError(400, `路径过浅，拒绝删除：${p}`);
    return p;
  }
  const host = hostOf(cfg, dest.host);
  const p = resolveRemote(host, dest.path);
  if (host.remoteRoots.includes(p)) throw new HttpError(400, '拒绝删除根目录本身');
  if (p.split('/').filter(Boolean).length < 3) throw new HttpError(400, `路径过浅，拒绝删除：${p}`);
  return p;
}

// Local deletions go to the Trash, so a mistake is recoverable. (The remote has
// no trash; that is stated plainly in the confirmation dialog.)
async function trashLocal(p) {
  const trash = path.join(os.homedir(), '.Trash');
  let target = path.join(trash, path.basename(p));
  if (await fsp.stat(target).catch(() => null)) {
    target = path.join(trash, `${path.basename(p)} ${Date.now()}`);
  }
  try {
    await fsp.rename(p, target);
  } catch (err) {
    // rename() cannot cross volumes. The user ticked the box expecting a
    // recoverable delete, so never silently downgrade to rm -rf — stop and say
    // so. The session is already terminated, so nothing is left half-synced.
    if (err.code === 'EXDEV') {
      throw new HttpError(409,
        `链接已断开，但没有删除：「${p}」和废纸篓不在同一个卷上，无法移入废纸篓。`
        + '为避免把「可恢复删除」悄悄变成不可恢复删除，这里停手了，请手动删除。');
    }
    throw err;
  }
  return target;
}

async function terminateLink(cfg, name, deleteDest) {
  const before = await listSessions();
  const s = before.find((x) => x.name === name);
  if (!s) throw new HttpError(404, '没有这条 obsync 链接');

  // Resolve and validate the target *before* terminating, so a bad request
  // fails without having torn the session down.
  let dest = null, targetPath = null;
  if (deleteDest) {
    dest = destinationOf(cfg, s);
    if (!dest) {
      throw new HttpError(400, '这条链接没有「被同步出来的一侧」（合并创建或来源未知），不能自动删除');
    }
    targetPath = assertDeletable(cfg, dest);
  }

  await run('mutagen', ['sync', 'terminate', name]);

  if (!deleteDest) return { deleted: null };

  // The session must be gone before any file is touched: deleting a folder
  // while sync is live would propagate the deletion to the *source*.
  const after = await listSessions();
  if (after.some((x) => x.name === name)) {
    throw new HttpError(500, '会话未能终止，已中止删除（否则删除会同步到源端）');
  }

  if (dest.side === 'local') {
    const moved = await trashLocal(targetPath);
    return { deleted: { side: 'local', path: targetPath, trashed: moved } };
  }
  await run('ssh', ['-o', 'BatchMode=yes', dest.host, `rm -rf -- ${shq(targetPath)}`]);
  return { deleted: { side: 'remote', path: targetPath, trashed: null } };
}


// ---------------------------------------------------------------------------
// hosts
// ---------------------------------------------------------------------------

// Alias suggestions from ~/.ssh/config, the way VS Code offers them. Include
// directives are followed one level, which is how this user's config is laid out.
async function sshConfigAliases() {
  const dir = path.join(os.homedir(), '.ssh');
  const seen = new Set();
  const out = [];

  const readOne = async (file, depth) => {
    const text = await fsp.readFile(file, 'utf8').catch(() => null);
    if (text === null) return;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(Host|Include)\s+(.+)$/i);
      if (!m) continue;
      if (/^include$/i.test(m[1])) {
        if (depth > 2) continue;
        for (const part of m[2].split(/\s+/)) {
          const p = expandTilde(part.replace(/^["']|["']$/g, ''));
          await readOne(path.isAbsolute(p) ? p : path.join(dir, p), depth + 1);
        }
        continue;
      }
      for (const alias of m[2].split(/\s+/)) {
        // Patterns and negations are matching rules, not connectable hosts.
        if (!alias || alias.includes('*') || alias.includes('?') || alias.startsWith('!')) continue;
        if (seen.has(alias)) continue;
        seen.add(alias);
        out.push(alias);
      }
    }
  };

  await readOne(path.join(dir, 'config'), 0);
  return out;
}

// One round trip proves reachability, proves key auth works without a prompt,
// and yields the default root — so the user never has to type an absolute path.
async function probeHost(alias) {
  const { stdout } = await run('ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', alias, 'echo "__H:$HOME"'],
    { timeout: 40000 });
  const line = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('__H:')).pop();
  const home = line && line.slice(4);
  if (!home || !home.startsWith('/')) throw new HttpError(502, '连上了，但没能读到远端 HOME 目录');
  return home;
}

async function addHost(cfg, { alias, label }) {
  const a = String(alias || '').trim();
  if (!a) throw new HttpError(400, '请填写主机');
  if (/\s/.test(a)) throw new HttpError(400, '主机名不能包含空格');
  if (cfg.hosts.some((h) => h.alias === a)) throw new HttpError(409, `主机「${a}」已经添加过了`);

  let home;
  try {
    home = await probeHost(a);
  } catch (err) {
    const detail = (err.stderr || '').trim().split('\n').filter(Boolean).pop() || err.message;
    throw new HttpError(502, `连不上「${a}」：${detail}`);
  }

  cfg.hosts.push({ alias: a, label: String(label || '').trim() || a, remoteRoots: [normRemote(home)] });
  saveConfig(cfg);
  return cfg.hosts[cfg.hosts.length - 1];
}

async function removeHost(cfg, alias) {
  const host = hostOf(cfg, alias);
  // Dropping the config would not stop the sessions — they would keep running
  // while becoming invisible here. Refuse instead of orphaning them.
  const live = (await listSessions()).filter((s) => s.host === alias);
  if (live.length) {
    throw new HttpError(409,
      `「${host.label || alias}」上还有 ${live.length} 条链接：`
      + live.map((s) => s.localName).join('、')
      + '。请先断开它们，否则会留下看不见但仍在同步的会话。');
  }
  cfg.hosts = cfg.hosts.filter((h) => h.alias !== alias);
  saveConfig(cfg);
  return { removed: alias, hosts: cfg.hosts };
}

// ---------------------------------------------------------------------------
// destination naming
// ---------------------------------------------------------------------------

// Folders created by a sync get a "[from:X] " prefix naming the side the
// content came from, so they are obviously not hand-made.
const PREFIX_RE = /^\[from:[^\]]*\]\s*/;

function stripPrefix(name) {
  // Repeat: a folder round-tripped a few times can carry more than one.
  let n = name;
  while (PREFIX_RE.test(n)) n = n.replace(PREFIX_RE, '');
  return n || name;
}

function originLabel(cfg, host, source) {
  return source === 'local' ? (cfg.localLabel || 'Mac') : (host.label || host.alias);
}

// The counterpart's basename. Strips any existing prefix first, otherwise a
// folder dragged back and forth accumulates "[from:A] [from:B] ...".
function destName(cfg, host, source, srcName) {
  const tpl = cfg.destPrefix ?? '[from:{name}] ';
  const base = stripPrefix(srcName);
  if (!tpl) return base;
  return tpl.replace('{name}', originLabel(cfg, host, source)).replace(/\//g, '_') + base;
}

// ---------------------------------------------------------------------------
// size probe — bounded: stops the moment the threshold is crossed
// ---------------------------------------------------------------------------

// Directory names from the ignore list that we can cheaply prune while probing,
// so a folder is not flagged for bytes that would never be synced anyway.
function pruneNames(cfg) {
  return (cfg.ignore || []).filter((p) => !p.includes('*') && !p.includes('/'));
}

async function probeRemoteSize(cfg, alias, p, limit, maxFiles) {
  const prunes = pruneNames(cfg).map((n) => `-name ${shq(n)}`).join(' -o ');
  const pruneExpr = prunes ? `\\( ${prunes} \\) -prune -o ` : '';
  // awk exits as soon as the limit is crossed; find then dies on SIGPIPE, so
  // this costs the same on a 5 MB folder as on a 188 GB one.
  const cmd = `find -H ${shq(p)} ${pruneExpr}-type f -printf '%s\\n' 2>/dev/null `
    + `| awk -v lim=${limit} -v maxn=${maxFiles} `
    + `'{s+=$1;n++; if(s>lim||n>maxn){printf "OVER %d %d\\n",s,n; exit}} END{printf "DONE %d %d\\n",s+0,n+0}'`;
  const { stdout } = await run('ssh', ['-o', 'BatchMode=yes', alias, cmd]);
  const [tag, bytes, files] = stdout.trim().split(/\s+/);
  return { over: tag === 'OVER', bytes: Number(bytes) || 0, files: Number(files) || 0 };
}

async function probeLocalSize(cfg, root, limit, maxFiles) {
  const prunes = new Set(pruneNames(cfg));
  let bytes = 0, files = 0, over = false;
  const walk = async (dir) => {
    if (over) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (over) return;
      if (prunes.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.isFile()) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (!st) continue;
      bytes += st.size; files++;
      if (bytes > limit || files > maxFiles) { over = true; return; }
    }
  };
  await walk(root);
  return { over, bytes, files };
}

// ---------------------------------------------------------------------------
// browsing
// ---------------------------------------------------------------------------

// A remembered directory can go stale — deleted on disk, or its root dropped
// from the allowlist. Verify before restoring, and fall back to the root rather
// than opening the pane on an error.
async function startLocalDir(cfg, requested) {
  if (requested) return resolveLocal(cfg, requested);
  const last = cfg.lastLocalDir;
  if (last) {
    try {
      const p = resolveLocal(cfg, last);
      const st = await fsp.stat(p);
      if (st.isDirectory()) return p;
    } catch { /* stale: fall through to the root */ }
  }
  return cfg.localRoots[0];
}

async function startRemoteDir(cfg, host, requested) {
  if (requested) return resolveRemote(host, requested);
  const last = host.lastRemoteDir;
  if (last) {
    try {
      const p = resolveRemote(host, last);
      if (await remoteIsDir(host.alias, p)) return p;
    } catch { /* stale: fall through to the root */ }
  }
  return host.remoteRoots[0];
}

// Remember where the user is, so the next launch reopens it. Written only on an
// actual change; the file is tiny and saveConfig renames atomically.
function remember(cfg, mutate) {
  const before = JSON.stringify([cfg.lastLocalDir, cfg.hosts.map((h) => h.lastRemoteDir)]);
  mutate();
  const after = JSON.stringify([cfg.lastLocalDir, cfg.hosts.map((h) => h.lastRemoteDir)]);
  if (before !== after) saveConfig(cfg);
}

async function listLocal(cfg, dir) {
  const target = await startLocalDir(cfg, dir);
  remember(cfg, () => { cfg.lastLocalDir = target; });
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const out = entries
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(target, e.name), dir: e.isDirectory() }));
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1));
  return { path: target, root: rootFor(target, cfg.localRoots, path.sep), roots: cfg.localRoots, entries: out };
}

async function listRemote(cfg, alias, dir) {
  const host = hostOf(cfg, alias);
  const target = await startRemoteDir(cfg, host, dir);
  remember(cfg, () => { hostOf(cfg, alias).lastRemoteDir = target; });
  // -H dereferences the starting point only: HPC homes are very often symlinks
  // (/users/x -> ../../volumes/...), and plain find would silently list nothing.
  // NUL-delimited so names containing newlines cannot corrupt the listing.
  const cmd = `test -d ${shq(target)} || { printf '${MISSING}'; exit 0; }; `
    + `find -H ${shq(target)} -maxdepth 1 -mindepth 1 -printf '%y\\t%f\\0' 2>/dev/null || true`;
  const { stdout } = await run('ssh', ['-o', 'BatchMode=yes', alias, cmd]);
  // Without this an unreadable or vanished directory would render as "empty".
  if (stdout.startsWith(MISSING)) throw new HttpError(404, `远端目录不存在或不可读：${target}`);

  const out = [];
  for (const rec of stdout.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const name = rec.slice(tab + 1);
    if (!name || name.startsWith('.')) continue;
    out.push({ name, path: posix.join(target, name), dir: rec.slice(0, tab) === 'd' });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1));
  return { path: target, root: rootFor(target, host.remoteRoots, '/'), roots: host.remoteRoots, entries: out };
}

// Opening a working dir outside every current root widens the allowlist — an
// explicit, persisted user decision rather than a silent bypass.
async function addRoot(cfg, { side, hostAlias, path: raw }) {
  if (!raw || !raw.trim()) throw new HttpError(400, '请填写路径');
  if (side === 'local') {
    const p = path.resolve(expandTilde(raw.trim()));
    const st = await fsp.stat(p).catch(() => null);
    if (!st || !st.isDirectory()) throw new HttpError(400, `本地文件夹不存在：${p}`);
    if (!cfg.localRoots.includes(p)) cfg.localRoots.push(p);
    saveConfig(cfg);
    return { path: p };
  }
  if (side === 'remote') {
    const host = hostOf(cfg, hostAlias);
    const p = normRemote(expandTilde(raw.trim()));
    if (!p.startsWith('/')) throw new HttpError(400, '远端路径必须是绝对路径');
    if (!(await remoteIsDir(hostAlias, p))) throw new HttpError(400, `远端文件夹不存在：${p}`);
    if (!host.remoteRoots.includes(p)) host.remoteRoots.push(p);
    saveConfig(cfg);
    return { path: p };
  }
  throw new HttpError(400, 'side 必须是 local 或 remote');
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new HttpError(413, 'body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Any page in the user's browser can POST to 127.0.0.1. A JSON content type
// forces a CORS preflight we never answer, but `text/plain` carrying a JSON
// body is a "simple request" and sails straight through — so check Origin
// explicitly on everything that changes state.
function assertSameOrigin(req, cfg) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (!origin) return; // curl and friends send none; browsers always do
  const allowed = [`http://127.0.0.1:${cfg.port}`, `http://localhost:${cfg.port}`];
  if (!allowed.includes(origin)) throw new HttpError(403, `cross-origin request refused: ${origin}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!within(file, PUBLIC_DIR, path.sep)) throw new HttpError(403, 'forbidden');
  const buf = await fsp.readFile(file).catch(() => { throw new HttpError(404, 'not found'); });
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const cfg = loadConfig();
  assertSameOrigin(req, cfg);

  if (!p.startsWith('/api/')) return serveStatic(res, p);

  if (req.method === 'GET' && p === '/api/state') {
    return json(res, 200, {
      hosts: cfg.hosts,
      localRoots: cfg.localRoots,
      destPrefix: cfg.destPrefix ?? '[from:{name}] ',
      localLabel: cfg.localLabel || 'Mac',
      syncMode: cfg.syncMode,
      ignore: cfg.ignore,
      sessions: await listSessions(),
    });
  }

  if (req.method === 'GET' && p === '/api/sessions') return json(res, 200, await listSessions());

  if (req.method === 'GET' && p === '/api/local') {
    return json(res, 200, await listLocal(cfg, url.searchParams.get('path')));
  }

  if (req.method === 'GET' && p === '/api/remote') {
    return json(res, 200, await listRemote(cfg, url.searchParams.get('host'), url.searchParams.get('path')));
  }

  if (req.method === 'GET' && p === '/api/ssh-hosts') {
    const known = new Set(cfg.hosts.map((h) => h.alias));
    const all = await sshConfigAliases();
    return json(res, 200, { aliases: all.filter((a) => !known.has(a)) });
  }

  if (req.method === 'POST' && p === '/api/hosts') {
    const host = await addHost(cfg, await readBody(req));
    return json(res, 201, { host, hosts: cfg.hosts });
  }

  if (req.method === 'POST' && p === '/api/hosts/remove') {
    const { alias } = await readBody(req);
    return json(res, 200, await removeHost(cfg, alias));
  }

  if (req.method === 'POST' && p === '/api/roots') {
    const r = await addRoot(cfg, await readBody(req));
    return json(res, 201, r);
  }

  if (req.method === 'POST' && p === '/api/links') {
    const made = await createLink(cfg, await readBody(req));
    return json(res, 201, { ...made, sessions: await listSessions() });
  }

  const m = p.match(/^\/api\/links\/([A-Za-z0-9][-A-Za-z0-9_.]*)\/(terminate|pause|resume|flush)$/);
  if (req.method === 'POST' && m) {
    if (m[2] === 'terminate') {
      const { deleteDest } = await readBody(req);
      const r = await terminateLink(cfg, m[1], !!deleteDest);
      return json(res, 200, { ...r, sessions: await listSessions() });
    }
    await sessionAction(m[1], m[2]);
    return json(res, 200, { sessions: await listSessions() });
  }

  throw new HttpError(404, 'not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    // mutagen/ssh failures land here; their stderr is the useful part.
    const detail = (err.stderr || '').trim() || err.message;
    if (status >= 500) console.error('[obsync]', detail);
    json(res, status, { error: detail });
  });
});

const boot = loadConfig();
// Loopback only: this server can start sync sessions, it must never be
// reachable from the network.
server.listen(boot.port, '127.0.0.1', () => {
  console.log(`obsync → http://127.0.0.1:${boot.port}`);
  console.log(`local roots → ${boot.localRoots.join(', ')}`);
});
