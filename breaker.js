'use strict';

// Circuit breaker for the ssh servers mutagen syncs to.
//
// Why this exists: OpenSSH >= 9.8 sshd ships PerSourcePenalties. Every
// connection that ends *before authenticating* (client gave up, timed out,
// failed auth) adds penalty time to the source IP; once it accrues, sshd refuses
// every new connection from that IP — your own terminal and VS Code included —
// with a bare "Not allowed at this time", for up to 10 minutes by default.
//
// mutagen is the perfect penalty generator. It hard-codes -oConnectTimeout=5,
// so against a merely *slow* sshd every reconnect gives up pre-auth, and it
// retries every 15 s forever, once per session. Six sessions on one login node
// get an IP banned within minutes. So:
//
//   detect  — per *server* (not per alias: two aliases sharing a HostName are
//             one sshd and one penalty account), trip on ~2 failed reconnects or
//             on any error that names the ban / a stalled banner;
//   pause   — every obsync session on that server, so mutagen stops retrying;
//   wait    — exponential backoff (2 → 5 → 10 → 20 min, ≥10 min after a ban);
//   probe   — ONE fully-authenticating `ssh … true`, never a bare TCP/banner
//             check (that is itself a pre-auth disconnect, i.e. more penalty),
//             and never two probes at once;
//   resume  — the sessions it paused, one at a time, a few seconds apart.
//
// Every pause / probe / resume / switch is written to ~/.obsync/breaker.log
// with the triggering error verbatim: the mutagen daemon keeps no log.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const DIR = path.join(os.homedir(), '.obsync');
const STATE_PATH = path.join(DIR, 'breaker.json');
const EVENT_LOG = path.join(DIR, 'breaker.log');
const WRAPPER_LOG = path.join(DIR, 'ssh-wrapper.log');
const SSH_BIN_DIR = path.join(DIR, 'ssh-bin');
const BACKUP_DIR = path.join(DIR, 'ssh-config-backups');
const WRAPPER_SRC = path.join(__dirname, 'libexec', 'ssh-wrapper.sh');
const MUTAGEN_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'io.mutagen.mutagen.plist');

// Seeing any of these once is enough to trip: the server is either refusing us
// already, or stalling before the banner (each such attempt is penalised).
const HARD = /Not allowed at this time|banner exchange|kex_exchange_identification/i;
const BANNED = /Not allowed at this time/i;
// Failures that never reach the server cannot earn a penalty, so retrying them
// costs nothing: probe again soon instead of escalating (laptop offline/asleep).
const OFFLINE = /Could not resolve hostname|nodename nor servname|Network is unreachable|No route to host/i;

const DEFAULTS = {
  enabled: true,
  tickSeconds: 5,
  // mutagen retries every 15 s after a ~5–30 s connect attempt, so a session
  // that has been down this long has failed about two reconnects.
  tripAfterSeconds: 35,
  backoffMinutes: [2, 5, 10, 20],
  bannedMinutes: 10,
  offlineRetryMinutes: 1,
  staggerSeconds: 8,
  healthyResetMinutes: 15,
  probeConnectTimeout: 30,
  // Backstop for a probe that never even got sshd's version string.
  probeBackstopSeconds: 30,
  // After login, `true` should exit at once; a hung shell is cut (no penalty).
  probeAuthedSeconds: 60,
  // How long "Offering public key" may sit before it is reported as MFA-pending.
  mfaNoticeSeconds: 8,
  mfaNotify: true,
  autoFailover: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}

function dur(ms) {
  return ms >= 60000 ? `${+(ms / 60000).toFixed(1)}m` : `${Math.round(ms / 1000)}s`;
}

function fmtVal(v) {
  if (Array.isArray(v)) v = v.join(',');
  v = String(v);
  return /^[^\s"=]+$/.test(v) ? v : JSON.stringify(v);
}

// The useful part of an ssh/mutagen failure is its last meaningful stderr line.
function errText(err) {
  const lines = String((err && err.stderr) || '').split('\n').map((l) => l.trim())
    .filter((l) => l && !/^Pseudo-terminal will not be allocated/.test(l));
  if (err && err.killed) lines.push(`(killed after timeout: ${err.message})`);
  return lines.slice(-3).join(' | ') || (err && err.message) || String(err);
}

// A probe's stderr is `ssh -v` output. The refusal we care most about,
// "banner line 0: Not allowed at this time", is itself a debug line, so search
// all of it for the decisive lines before falling back to the last plain ones.
function probeError(res) {
  const lines = String(res.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const decisive = lines.filter((l) => HARD.test(l)).map((l) => l.replace(/^debug\d: /, ''));
  const plain = lines.filter((l) => !/^(debug\d|OpenSSH_|Pseudo-terminal)/.test(l));
  const out = [...new Set([...decisive.slice(-2), ...plain.slice(-2)])];
  if (res.killed === 'connect') out.push('（连 sshd 的版本串都没收到，后备超时结束）');
  if (res.killed === 'authed') out.push('（认证成功但远端 shell 没退出，已断开——认证后断开不加罚时）');
  if (res.phase === 'auth' && !res.killed) out.push('（认证阶段被服务器断开：可能是 MFA 未完成、LoginGraceTime 到期或被拒）');
  return out.join(' | ') || `ssh exited ${res.code}`;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

class Breaker {
  constructor({ run, listSessions, loadConfig }) {
    this.run = run;
    this.listSessions = listSessions;
    this.loadConfig = loadConfig;

    this.endpoints = {};   // key "host:port" -> record (persisted)
    this.banned = {};      // hostName -> epoch ms the ban should have lifted
    this.downSince = new Map();   // session name -> first tick seen disconnected
    this.resolved = new Map();    // alias -> { key, hostName, port, at }
    this.conns = new Map();       // wrapper-log pid -> { alias, phase, offeringAt }
    this.mfaNoted = new Set();    // aliases whose MFA wait was already logged
    this.wOffset = 0;
    this.wPartial = '';
    this.probing = null;          // key of the one probe allowed in flight
    this.ticking = false;
    this.lockTail = Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // lifecycle, persistence, logging
  // -------------------------------------------------------------------------

  opts() {
    let cfg = {};
    try { cfg = this.loadConfig().breaker || {}; } catch { /* use defaults */ }
    return { ...DEFAULTS, ...cfg };
  }

  start() {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      this.endpoints = s.endpoints || {};
      this.banned = s.banned || {};
    } catch { /* first run */ }
    // A probe or resume that was mid-flight when the server died starts over:
    // probing becomes "probe now", resuming becomes "probe, then resume".
    for (const r of Object.values(this.endpoints)) {
      if (r.state === 'probing' || r.state === 'resuming') { r.state = 'open'; r.until = Date.now(); }
    }
    // Only errors from now on matter; history was handled by the last run.
    try { this.wOffset = fs.statSync(WRAPPER_LOG).size; } catch { this.wOffset = 0; }

    const w = this.installWrapper();
    const open = Object.values(this.endpoints).filter((r) => r.state !== 'closed');
    this.event('START', {
      wrapper: w.daemonUsesIt ? 'active' : 'not-configured',
      open: open.map((r) => r.key),
    });
    if (!w.daemonUsesIt) {
      this.event('WARN', { msg: 'mutagen 守护进程未使用 obsync 的 ssh 包装脚本：mutagen 仍是 5 秒连接超时，且重连报错不可见（熔断仅靠断线时长触发）。运行 `obsync ssh-wrapper on` 启用。' });
    }

    const tick = () => this.tick().finally(() => {
      this.timer = setTimeout(tick, this.opts().tickSeconds * 1000);
    });
    this.timer = setTimeout(tick, 1000);
  }

  save() {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ endpoints: this.endpoints, banned: this.banned }, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  }

  event(name, fields = {}) {
    const parts = [stamp(), name.padEnd(11)];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      parts.push(`${k}=${fmtVal(v)}`);
    }
    const line = parts.join(' ');
    console.log('[breaker]', line);
    try {
      const st = fs.statSync(EVENT_LOG, { throwIfNoEntry: false });
      if (st && st.size > 5 * 1024 * 1024) fs.renameSync(EVENT_LOG, EVENT_LOG + '.1');
      fs.appendFileSync(EVENT_LOG, line + '\n');
    } catch (err) { console.error('[breaker] cannot write log:', err.message); }
  }

  async readLog(n = 200) {
    const text = await fsp.readFile(EVENT_LOG, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).slice(-n);
  }

  // Serialise every state mutation (tick trips, resume steps, switches) so a
  // resume can never interleave with the trip that should abort it.
  withLock(fn) {
    const run = this.lockTail.then(fn, fn);
    this.lockTail = run.catch(() => {});
    return run;
  }

  // -------------------------------------------------------------------------
  // the ssh wrapper
  // -------------------------------------------------------------------------

  // Keep ~/.obsync/ssh-bin/{ssh,scp} identical to the repo copy. Written via
  // rename, so the daemon can never exec a half-written script.
  installWrapper() {
    let installed = false;
    try {
      const src = fs.readFileSync(WRAPPER_SRC);
      fs.mkdirSync(SSH_BIN_DIR, { recursive: true });
      for (const name of ['ssh', 'scp']) {
        const dst = path.join(SSH_BIN_DIR, name);
        let same = false;
        try { same = fs.readFileSync(dst).equals(src); } catch { /* missing */ }
        if (same) continue;
        const tmp = dst + '.tmp';
        fs.writeFileSync(tmp, src);
        fs.chmodSync(tmp, 0o755);
        fs.renameSync(tmp, dst);
      }
      installed = true;
    } catch (err) {
      this.event('WARN', { msg: '无法安装 ssh 包装脚本', error: err.message });
    }
    // The LaunchAgent (`mutagen daemon register`) is how the daemon normally
    // runs; `obsync ssh-wrapper on` adds MUTAGEN_SSH_PATH to it.
    let daemonUsesIt = false;
    try { daemonUsesIt = fs.readFileSync(MUTAGEN_PLIST, 'utf8').includes(SSH_BIN_DIR); } catch { /* not registered */ }
    this.wrapperInstalled = installed;
    this.wrapperActive = daemonUsesIt;
    return { installed, daemonUsesIt };
  }

  // New lines of ~/.obsync/ssh-wrapper.log, as { alias, text } for stderr lines.
  readWrapperLog(aliases) {
    let st;
    try { st = fs.statSync(WRAPPER_LOG); } catch { return []; }
    if (st.size < this.wOffset) { this.wOffset = 0; this.wPartial = ''; }
    if (st.size === this.wOffset) return [];
    // Never slurp more than 1 MB per tick; an old backlog is not actionable.
    const from = Math.max(this.wOffset, st.size - 1024 * 1024);
    const len = st.size - from;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(WRAPPER_LOG, 'r');
    try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
    this.wOffset = st.size;

    const lines = (this.wPartial + buf.toString('utf8')).split('\n');
    this.wPartial = lines.pop();
    const out = [];
    for (const line of lines) {
      const [, pid, kind, , ...rest] = line.split('\t');
      const text = rest.join('\t');
      if (kind === 'start') {
        const alias = matchAlias(text, aliases);
        if (alias) this.conns.set(pid, { alias, phase: 'connect', offeringAt: null });
        if (this.conns.size > 1000) this.conns.delete(this.conns.keys().next().value);
      } else if (kind === 'end') {
        this.conns.delete(pid);
      } else if (kind === 'err') {
        const c = this.conns.get(pid);
        if (!c) continue;
        if (/Offering public key/.test(text) && c.phase !== 'authed') { c.phase = 'auth'; c.offeringAt = c.offeringAt || Date.now(); }
        if (/Authenticated to /.test(text)) c.phase = 'authed';
        out.push({ alias: c.alias, text });
      }
    }
    // Rotate here (the wrapper only ever appends, so a rename is safe).
    if (st.size > 4 * 1024 * 1024) {
      try { fs.renameSync(WRAPPER_LOG, WRAPPER_LOG + '.1'); this.wOffset = 0; this.wPartial = ''; } catch { /* next tick */ }
    }
    return out;
  }

  // A mutagen ssh for this alias that is alive and has sat at "Offering public
  // key" for a while: MFA is pending. Pausing now would kill it pre-auth.
  mfaPending(alias) {
    const o = this.opts();
    for (const [pid, c] of this.conns) {
      if (c.alias !== alias || c.phase !== 'auth') continue;
      try { process.kill(Number(pid), 0); } catch { this.conns.delete(pid); continue; }
      if (Date.now() - c.offeringAt >= o.mfaNoticeSeconds * 1000) return c.offeringAt;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // alias -> server resolution (`ssh -G` only parses config; it never connects)
  // -------------------------------------------------------------------------

  async resolve(alias) {
    const hit = this.resolved.get(alias);
    // Short TTL: a HostName edited by hand must take effect within a tick or two.
    if (hit && Date.now() - hit.at < 15000) return hit;
    try {
      const { stdout } = await this.run('/usr/bin/ssh', ['-G', alias], { timeout: 10000 });
      const get = (k) => (stdout.match(new RegExp(`^${k} (.+)$`, 'mi')) || [])[1];
      const hostName = (get('hostname') || alias).trim().toLowerCase();
      const port = (get('port') || '22').trim();
      const r = { key: `${hostName}:${port}`, hostName, port, at: Date.now() };
      this.resolved.set(alias, r);
      return r;
    } catch {
      return hit || null;
    }
  }

  async resolveAll(aliases) {
    const keyOf = {};
    for (const a of aliases) {
      const r = await this.resolve(a);
      if (r) keyOf[a] = r.key;
    }
    this.keyOf = keyOf;
    return keyOf;
  }

  aliasesOn(key) {
    return Object.keys(this.keyOf || {}).filter((a) => this.keyOf[a] === key);
  }

  rec(key) {
    if (!this.endpoints[key]) {
      const [hostName, port] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
      this.endpoints[key] = { key, hostName, port, aliases: [], state: 'closed', level: 0, paused: [] };
    }
    return this.endpoints[key];
  }

  // An open record governs only the aliases it tripped (or was moved with), not
  // every alias that happens to resolve to the same server afterwards.
  recForAlias(alias) {
    const key = this.keyOf && this.keyOf[alias];
    const r = key ? this.endpoints[key] : null;
    return r && (r.state === 'closed' || r.aliases.includes(alias)) ? r : null;
  }

  // If an open record's aliases now point at another server (HostName edited by
  // hand, or by switchNode), carry the record over: the sessions it paused still
  // need resuming, and the new server has not banned us, so probe it soon.
  rekey() {
    for (const r of Object.values(this.endpoints)) {
      const live = r.aliases.map((a) => this.keyOf[a]).filter(Boolean);
      if (!live.length || live.includes(r.key)) continue;
      const newKey = live[0];
      delete this.endpoints[r.key];
      if (r.state === 'closed') continue;
      const old = r.key;
      const target = this.rec(newKey);
      const moved = r.aliases.filter((a) => this.keyOf[a] === newKey);
      // Only the moved aliases' sessions are paused; others already on the new
      // server are healthy and stay untouched unless it was tripped itself.
      target.aliases = target.state === 'closed' ? moved : [...new Set([...target.aliases, ...moved])];
      Object.assign(target, {
        state: target.state === 'closed' ? r.state : target.state,
        paused: [...new Set([...(target.paused || []), ...r.paused])],
        reason: r.reason, error: r.error, trippedAt: r.trippedAt,
        level: 0, until: this.banned[target.hostName] > Date.now() ? this.banned[target.hostName] : Date.now(),
      });
      this.event('REKEY', { from: old, to: newKey, aliases: target.aliases, paused: target.paused.length });
    }
  }

  // -------------------------------------------------------------------------
  // detection
  // -------------------------------------------------------------------------

  async tick() {
    if (this.ticking) return;
    const opts = this.opts();
    if (!opts.enabled) return;
    this.ticking = true;
    try {
      await this.withLock(async () => {
        const cfg = this.loadConfig();
        const sessions = await this.listSessions();
        const aliases = [...new Set([...cfg.hosts.map((h) => h.alias), ...sessions.map((s) => s.host)])]
          .filter(Boolean);
        await this.resolveAll(aliases);
        this.rekey();
        const now = Date.now();

        // Collect at most one trigger per server; an explicit error beats a timeout.
        const triggers = new Map();
        const add = (key, t) => {
          if (!key) return;
          const prev = triggers.get(key);
          if (!prev || (t.hard && !prev.hard)) triggers.set(key, t);
        };

        for (const s of sessions) {
          if (s.paused || s.status.startsWith('halted') || !isDown(s)) { this.downSince.delete(s.name); continue; }
          if (!this.downSince.has(s.name)) this.downSince.set(s.name, now);
          const key = this.keyOf[s.host];
          const downFor = Math.round((now - this.downSince.get(s.name)) / 1000);
          if (HARD.test(s.lastError || '')) {
            add(key, { hard: true, source: 'mutagen', session: s.name, alias: s.host, error: s.lastError,
              reason: `会话「${s.localName}」报错` });
          } else if (downFor >= opts.tripAfterSeconds && this.mfaPending(s.host)) {
            // Not a failed reconnect: a login waiting on MFA. Leave it alone.
            if (!this.mfaNoted.has(s.host)) {
              this.mfaNoted.add(s.host);
              this.event('MFA-WAIT', { node: this.keyOf[s.host], alias: s.host, session: s.name,
                msg: 'mutagen 的连接卡在 Offering public key，视为等待 MFA，暂不熔断', url: this.lastMfaUrl });
              this.notifyMfa(s.host, this.lastMfaUrl);
            }
          } else if (downFor >= opts.tripAfterSeconds) {
            add(key, { hard: false, source: 'mutagen', session: s.name, alias: s.host, error: s.lastError || '',
              reason: `会话「${s.localName}」已连续 ${downFor}s 连不上远端（≈2 次重连失败，状态 ${s.status}）` });
          }
        }
        for (const l of this.readWrapperLog(aliases)) {
          const url = (l.text.match(/https?:\/\/\S*mfa\S*/i) || [])[0];
          if (url) this.lastMfaUrl = url;
          if (HARD.test(l.text)) {
            add(this.keyOf[l.alias], { hard: true, source: 'ssh-wrapper', alias: l.alias, error: l.text,
              reason: 'mutagen 的 ssh 连接报错' });
          }
        }

        for (const a of [...this.mfaNoted]) if (!this.mfaPending(a)) this.mfaNoted.delete(a);

        let tripped = false;
        for (const [key, t] of triggers) {
          const r = this.rec(key);
          if (r.state === 'closed' || r.state === 'resuming') { await this.trip(r, t, sessions); tripped = true; }
        }
        // The snapshot predates any pause we just issued; don't "enforce" on it.
        const current = tripped ? await this.listSessions() : sessions;

        for (const r of Object.values(this.endpoints)) {
          // A closed record follows config; an open one keeps the set it tripped.
          r.aliases = r.state === 'closed'
            ? this.aliasesOn(r.key)
            : r.aliases.filter((a) => this.keyOf[a] === r.key);
          if (r.state === 'open' || r.state === 'probing') {
            // Something unpaused a session on a tripped server (CLI, another
            // tool): re-pause it, or it will keep feeding the penalty counter.
            const stray = current.filter((s) => r.aliases.includes(s.host) && !s.paused);
            if (stray.length) await this.pauseAll(r, stray, 'ENFORCE');
          }
          if (r.state === 'closed' && r.level > 0 && r.recoveredAt
              && now - r.recoveredAt > opts.healthyResetMinutes * 60000
              && current.filter((s) => r.aliases.includes(s.host)).every((s) => !isDown(s))) {
            r.level = 0;
            this.event('RESET', { node: r.hostName, aliases: r.aliases, msg: `稳定 ${opts.healthyResetMinutes} 分钟，退避级别归零` });
          }
        }
        this.save();
      });

      // Due probes run outside the lock (they take up to ~30 s), one at a time.
      if (!this.probing) {
        const due = Object.values(this.endpoints)
          .filter((r) => r.state === 'open' && Date.now() >= (r.until || 0))
          .sort((a, b) => (a.until || 0) - (b.until || 0))[0];
        if (due) this.probe(due.key).catch((err) => console.error('[breaker] probe:', err));
      }
    } catch (err) {
      console.error('[breaker] tick failed:', err.message);
    } finally {
      this.ticking = false;
    }
  }

  // obsync's own ssh calls report back here, so its listings can trip too.
  observe(alias, stderr) {
    if (!HARD.test(stderr || '')) return;
    this.withLock(async () => {
      const key = this.keyOf && this.keyOf[alias];
      if (!key) return;
      const r = this.rec(key);
      if (r.state !== 'closed' && r.state !== 'resuming') return;
      const sessions = await this.listSessions();
      await this.trip(r, { hard: true, source: 'obsync-ssh', alias, error: lastLine(stderr), reason: 'obsync 浏览目录时 ssh 报错' }, sessions);
      this.save();
    }).catch((err) => console.error('[breaker] observe:', err.message));
  }

  // -------------------------------------------------------------------------
  // trip / backoff
  // -------------------------------------------------------------------------

  async pauseAll(r, victims, tag) {
    const names = victims.map((s) => s.name);
    if (!names.length) return;
    try {
      await this.run('mutagen', ['sync', 'pause', ...names], { timeout: 60000 });
      r.paused = [...new Set([...r.paused, ...names])];
      for (const n of names) this.downSince.delete(n);
      this.event('PAUSE', { node: r.hostName, by: tag, sessions: names,
        msg: tag === 'ENFORCE' ? '熔断期间有会话被外部恢复，重新暂停' : undefined });
    } catch (err) {
      this.event('PAUSE-FAIL', { node: r.hostName, sessions: names, error: errText(err) });
    }
  }

  nextWait(r, error) {
    const o = this.opts();
    if (OFFLINE.test(error || '')) return { ms: o.offlineRetryMinutes * 60000, why: '本机网络/DNS 不通，不会加罚时，不升级退避' };
    const steps = o.backoffMinutes;
    let min = steps[Math.min(r.level || 0, steps.length - 1)];
    r.level = (r.level || 0) + 1;
    let why = `退避第 ${r.level} 级`;
    if (BANNED.test(error || '') && min < o.bannedMinutes) { min = o.bannedMinutes; why += `，已被封禁，至少等 ${o.bannedMinutes} 分钟`; }
    return { ms: min * 60000, why };
  }

  async trip(r, t, sessions) {
    const was = r.state;
    const aliases = this.aliasesOn(r.key);
    const victims = sessions.filter((s) => aliases.includes(s.host) && !s.paused);
    r.aliases = aliases;
    r.state = 'open';
    const wait = this.nextWait(r, t.error);
    r.until = Date.now() + wait.ms;
    Object.assign(r, { reason: t.reason, error: t.error, source: t.source, trippedAt: Date.now() });
    if (BANNED.test(t.error || '')) this.banned[r.hostName] = Date.now() + this.opts().bannedMinutes * 60000;

    this.event('TRIP', {
      node: r.hostName, aliases, from: was, source: t.source, session: t.session,
      wait: dur(wait.ms), why: wait.why, reason: t.reason, error: t.error || '(none)',
    });
    await this.pauseAll(r, victims, 'TRIP');

    // Optional: don't sit out a ban — move to a sibling login node right away.
    if (this.opts().autoFailover && BANNED.test(t.error || '')) {
      const alt = this.failoverCandidates(aliases).find((h) => h !== r.hostName && !(this.banned[h] > Date.now()));
      if (alt) setTimeout(() => this.switchNode(aliases[0], alt, { auto: true }).catch((e) => this.event('SWITCH-FAIL', { error: e.message })), 0);
    }
  }

  // -------------------------------------------------------------------------
  // probe + staggered resume
  // -------------------------------------------------------------------------

  async probe(key, { manual = false } = {}) {
    if (this.probing) throw httpError(409, `已有探测在进行（${this.probing}），不并发探测`);
    const r = this.endpoints[key];
    if (!r || r.state === 'closed') throw httpError(409, '这台服务器没有处于熔断状态');
    if (r.state === 'resuming') throw httpError(409, '正在恢复中');
    const alias = r.aliases.find((a) => this.keyOf[a] === key) || r.aliases[0];
    this.probing = key;
    r.state = 'probing';
    r.mfaSince = null;
    const o = this.opts();
    // A real login that runs `true`: a probe that stops at TCP or the banner is
    // itself a pre-auth disconnect and earns the very penalty we are avoiding.
    // ControlPath=none: a reused master would prove nothing about new logins.
    const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${o.probeConnectTimeout}`,
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', alias, 'true'];
    this.event('PROBE', { node: r.hostName, alias, manual: manual || undefined, cmd: `ssh ${args.join(' ')}` });
    const t0 = Date.now();
    try {
      const res = await this.runProbe(args, o, () => {
        // Stuck at "Offering public key": the server is holding the key
        // until MFA is approved. Waiting is the whole point — say so.
        r.mfaSince = Date.now();
        this.event('PROBE-MFA', { node: r.hostName, alias, msg: '卡在 Offering public key，视为等待 MFA，不会超时 kill', url: this.lastMfaUrl });
        this.notifyMfa(r.hostName, this.lastMfaUrl);
      });
      r.mfaSince = null;
      if (res.ok) {
        this.event('PROBE-OK', { node: r.hostName, alias, took: `${((Date.now() - t0) / 1000).toFixed(1)}s` });
        r.state = 'resuming';
        this.save();
        this.resumeAll(key).catch((err) => console.error('[breaker] resume:', err));
        return { ok: true };
      }
      const error = probeError(res);
      await this.withLock(async () => {
        const wait = this.nextWait(r, res.stderr);
        r.state = 'open';
        r.until = Date.now() + wait.ms;
        r.error = error;
        if (BANNED.test(res.stderr)) this.banned[r.hostName] = Date.now() + o.bannedMinutes * 60000;
        this.event('PROBE-FAIL', { node: r.hostName, alias, phase: res.phase, took: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
          wait: dur(wait.ms), why: wait.why, error });
        this.save();
      });
      return { ok: false, error };
    } finally {
      this.probing = null;
    }
  }

  // Run `ssh -v …` and follow its progress through stderr, because when it is
  // safe to give up depends on how far it got:
  //   connect  — TCP + waiting for sshd's version string. ConnectTimeout bounds
  //              this inside ssh; ours is only a backstop for a wedged process.
  //   auth     — sshd has answered. From here until authentication, killing
  //              the client is a pre-auth disconnect (= penalty), and a stall
  //              at "Offering public key" means MFA is pending. NEVER killed:
  //              sshd's own LoginGraceTime is the only clock.
  //   authed   — logged in; a kill now costs nothing, so a hung remote shell
  //              is cut after probeAuthedSeconds.
  runProbe(args, o, onMfa) {
    return new Promise((resolve) => {
      let child;
      try { child = this.spawnProbe(['-v', ...args]); } catch (err) {
        resolve({ ok: false, stderr: err.message, phase: 'spawn' }); return;
      }
      let stderr = '', partial = '', phase = 'connect', killed = null, mfaTimer = null, authedTimer = null;
      const backstop = setTimeout(() => {
        if (phase === 'connect') { killed = 'connect'; child.kill('SIGTERM'); }
      }, (o.probeConnectTimeout + o.probeBackstopSeconds) * 1000);
      const onLine = (l) => {
        stderr += l + '\n';
        const url = (l.match(/https?:\/\/\S*mfa\S*/i) || [])[0];
        if (url) this.lastMfaUrl = url;
        if (phase === 'connect' && /Remote protocol version|Authenticating to|Offering public key/.test(l)) {
          phase = 'auth';
          clearTimeout(backstop);
        }
        if (phase === 'auth' && !mfaTimer && /Offering public key/.test(l)) {
          mfaTimer = setTimeout(() => { if (phase === 'auth') onMfa(); }, o.mfaNoticeSeconds * 1000);
        }
        if (/Authenticated to /.test(l)) {
          phase = 'authed';
          clearTimeout(mfaTimer);
          authedTimer = setTimeout(() => { killed = 'authed'; child.kill('SIGTERM'); }, o.probeAuthedSeconds * 1000);
        }
      };
      child.stderr.on('data', (d) => {
        const lines = (partial + d).split('\n');
        partial = lines.pop();
        lines.forEach(onLine);
      });
      child.on('error', (err) => { stderr += err.message + '\n'; });
      child.on('close', (code) => {
        if (partial) onLine(partial);
        [backstop, mfaTimer, authedTimer].forEach(clearTimeout);
        resolve({ ok: code === 0 && !killed, code, phase, killed, stderr });
      });
    });
  }

  spawnProbe(args) {
    return spawn('/usr/bin/ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  }

  // MFA needs a human; the UI may not be open, so also post a macOS notification.
  notifyMfa(node, url) {
    if (!this.opts().mfaNotify) return;
    const msg = `${node} 在等 MFA 认证${url ? '：' + url : ''}`;
    execFile('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "obsync"`], () => {});
  }

  async resumeAll(key) {
    const o = this.opts();
    let r = this.endpoints[key];
    const names = [...r.paused];
    this.event('RESUME-RUN', { node: r.hostName, sessions: names, stagger: `${o.staggerSeconds}s` });
    for (let i = 0; i < names.length; i++) {
      const stop = await this.withLock(async () => {
        r = this.endpoints[key];
        if (!r || r.state !== 'resuming') return 'aborted';
        const name = names[i];
        const s = (await this.listSessions()).find((x) => x.name === name);
        if (!s || !s.paused) { r.paused = r.paused.filter((n) => n !== name); return null; }
        try {
          await this.run('mutagen', ['sync', 'resume', name], { timeout: 120000 });
          r.paused = r.paused.filter((n) => n !== name);
          this.event('RESUME', { node: r.hostName, session: name, local: s.localName, n: `${i + 1}/${names.length}` });
          this.save();
          return null;
        } catch (err) {
          // A failed resume leaves the session unpaused and auto-reconnecting:
          // trip again right away so it is paused before it retries.
          r.paused = r.paused.filter((n) => n !== name);
          await this.trip(r, { hard: HARD.test(errText(err)), source: 'resume', session: name,
            error: errText(err), reason: `恢复「${s.localName}」时连接失败` }, await this.listSessions());
          this.save();
          return 'tripped';
        }
      });
      if (stop) {
        this.event('RESUME-STOP', { node: (this.endpoints[key] || r).hostName, msg: stop === 'aborted' ? '状态已变化，停止恢复' : '恢复途中再次熔断' });
        return;
      }
      if (i < names.length - 1) await sleep(o.staggerSeconds * 1000);
    }
    await this.withLock(async () => {
      r = this.endpoints[key];
      if (!r || r.state !== 'resuming') return;
      Object.assign(r, { state: 'closed', recoveredAt: Date.now(), until: null, reason: null, error: null, paused: [] });
      this.event('CLOSED', { node: r.hostName, aliases: r.aliases, level: r.level, msg: '全部会话已恢复' });
      this.save();
    });
  }

  // -------------------------------------------------------------------------
  // failover: point an alias's Host block at a sibling login node
  // -------------------------------------------------------------------------

  failoverCandidates(aliases) {
    let cfg;
    try { cfg = this.loadConfig(); } catch { return []; }
    const out = [];
    for (const h of cfg.hosts) {
      if (aliases.includes(h.alias)) for (const n of h.failover || []) out.push(String(n).toLowerCase());
    }
    return [...new Set(out)];
  }

  async switchNode(alias, hostName, { force = false, auto = false } = {}) {
    hostName = String(hostName || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(hostName)) throw httpError(400, `不合法的主机名：${hostName}`);
    if (!this.keyOf || !this.keyOf[alias]) await this.resolveAll([alias]);
    const cur = await this.resolve(alias);
    if (!cur) throw httpError(400, `无法解析 ${alias}`);
    const candidates = this.failoverCandidates(this.aliasesOn(cur.key).concat(alias));
    if (!candidates.includes(hostName)) {
      throw httpError(400, `${hostName} 不在 ${alias} 的 failover 列表里（~/.obsync/config.json → hosts[].failover）`);
    }
    if (hostName === cur.hostName) throw httpError(409, `${alias} 已经指向 ${hostName}`);
    const bannedLeft = (this.banned[hostName] || 0) - Date.now();
    if (bannedLeft > 0 && !force) {
      throw httpError(409, `${hostName} 刚封禁过本机 IP，约 ${Math.ceil(bannedLeft / 60000)} 分钟后才解封；不要在被封的节点上重试`);
    }
    if (this.probing) throw httpError(409, '正在探测中，请稍后再切换');

    const newKey = await this.withLock(async () => {
      const r = this.rec(cur.key);
      const aliases = [...new Set([...this.aliasesOn(cur.key), alias])];
      r.aliases = aliases;
      const sessions = await this.listSessions();
      const prevState = r.state;
      r.state = 'open';
      r.until = Infinity; // nothing probes the old node while we switch
      r.reason = `${auto ? '自动' : '手动'}切换登录节点 ${cur.hostName} → ${hostName}`;
      this.event('SWITCH', { from: cur.hostName, to: hostName, aliases, auto: auto || undefined, was: prevState });
      await this.pauseAll(r, sessions.filter((s) => aliases.includes(s.host) && !s.paused), 'SWITCH');

      let edit;
      try {
        edit = await setSshHostName(alias, hostName);
      } catch (err) {
        r.until = Date.now();
        this.event('SWITCH-FAIL', { alias, to: hostName, error: err.message });
        throw httpError(500, `修改 ~/.ssh/config 失败：${err.message}`);
      }
      this.resolved.clear();
      const now = await this.resolve(alias);
      if (!now || now.hostName !== hostName) {
        await fsp.copyFile(edit.backup, edit.file);
        this.resolved.clear();
        r.until = Date.now();
        this.event('SWITCH-FAIL', { alias, to: hostName, file: edit.file, error: `ssh -G 解析结果是 ${now && now.hostName}，已从备份还原` });
        throw httpError(500, `改完后 ssh -G 仍解析到 ${now && now.hostName}（可能有更早的 Host 块覆盖了 HostName），已还原`);
      }
      this.event('SSH-CONFIG', { file: edit.file, line: edit.line, from: edit.from, to: hostName, backup: edit.backup });
      await this.resolveAll(Object.keys(this.keyOf).concat(alias));
      this.rekey();
      const nr = this.endpoints[now.key];
      // Infinity keeps the tick from starting a second probe of its own.
      if (nr) { nr.level = 0; nr.until = Infinity; nr.reason = r.reason; }
      this.save();
      return now.key;
    });

    try {
      return await this.probe(newKey, { manual: true });
    } catch (err) {
      const nr = this.endpoints[newKey];
      if (nr && nr.state === 'open') nr.until = Date.now();
      return { ok: false, error: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // queries + guards used by server.js
  // -------------------------------------------------------------------------

  // obsync's own ssh() must not knock on a tripped server either.
  assertSshAllowed(alias) {
    const r = this.recForAlias(alias);
    if (r && (r.state === 'open' || r.state === 'probing')) {
      throw httpError(503, `「${alias}」所在服务器 ${r.hostName} 熔断中（${r.reason || ''}），暂不连接；可在中栏点「立即探测」`);
    }
  }

  assertResumeAllowed(session) {
    const r = this.recForAlias(session.host);
    if (r && r.state !== 'closed') {
      throw httpError(409, `${r.hostName} 熔断中，不能手动恢复单个会话（会立刻重连、继续加罚时）。请点「立即探测」，成功后会自动错峰恢复。`);
    }
  }

  async manualProbe(alias) {
    if (!this.keyOf || !this.keyOf[alias]) await this.resolveAll([alias]);
    const key = this.keyOf[alias];
    if (!key) throw httpError(400, `无法解析 ${alias}`);
    return this.probe(key, { manual: true });
  }

  snapshot() {
    const now = Date.now();
    return {
      enabled: this.opts().enabled,
      wrapperActive: !!this.wrapperActive,
      probing: this.probing,
      now,
      endpoints: Object.values(this.endpoints).map((r) => ({
        key: r.key, hostName: r.hostName, aliases: r.aliases, state: r.state, level: r.level,
        until: Number.isFinite(r.until) ? r.until : null, reason: r.reason, error: r.error,
        trippedAt: r.trippedAt, paused: r.paused, mfaSince: r.mfaSince || null,
        failover: this.failoverCandidates(r.aliases).map((h) => ({
          hostName: h, current: h === r.hostName, bannedUntil: this.banned[h] > now ? this.banned[h] : null,
        })),
      })),
      mfa: Object.fromEntries([...new Set([...this.conns.values()].map((c) => c.alias))]
        .map((a) => [a, this.mfaPending(a)]).filter(([, t]) => t)),
      mfaUrl: this.lastMfaUrl || null,
      aliases: Object.fromEntries(Object.entries(this.keyOf || {}).map(([a, k]) => [a, k])),
    };
  }
}

function isDown(s) {
  return !s.betaConnected || s.status === 'disconnected' || s.status.startsWith('connecting');
}

function lastLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
}

// The wrapper logs the full argv. The target is the token that is an alias,
// optionally user@-prefixed (ssh) or :path-suffixed (scp).
function matchAlias(argv, aliases) {
  for (const t of argv.split(' ')) {
    const host = t.replace(/^[^@]*@/, '').replace(/:.*$/, '');
    if (aliases.includes(host)) return host;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ~/.ssh/config editing — HostName inside the block that names the alias
// ---------------------------------------------------------------------------

async function sshConfigFiles() {
  const dir = path.join(os.homedir(), '.ssh');
  const main = path.join(dir, 'config');
  const out = [main];
  const text = await fsp.readFile(main, 'utf8').catch(() => '');
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(/^Include\s+(.+)$/i);
    if (!m) continue;
    for (const part of m[1].split(/\s+/)) {
      let p = part.replace(/^["']|["']$/g, '');
      if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
      if (!path.isAbsolute(p)) p = path.join(dir, p);
      if (!p.includes('*')) out.push(p);
    }
  }
  return out;
}

async function setSshHostName(alias, hostName) {
  for (const file of await sshConfigFiles()) {
    const real = await fsp.realpath(file).catch(() => null);
    if (!real) continue;
    const text = await fsp.readFile(real, 'utf8');
    const lines = text.split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(Host|Match)(?:\s*=\s*|\s+)(.*)$/i);
      if (!m) continue;
      if (start >= 0) break; // reached the next block
      if (/^host$/i.test(m[1]) && m[2].split(/\s+/).map((x) => x.replace(/^"|"$/g, '')).includes(alias)) start = i;
    }
    if (start < 0) continue;

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*(Host|Match)(\s|=)/i.test(lines[i])) { end = i; break; }
    }
    let at = -1, from = null;
    for (let i = start + 1; i < end; i++) {
      const m = lines[i].match(/^(\s*HostName(?:\s*=\s*|\s+))(\S+)(.*)$/i);
      if (m) { at = i; from = m[2]; lines[i] = m[1] + hostName + m[3]; break; }
    }
    if (at < 0) {
      const indent = (lines[start + 1] || '').match(/^\s*/)[0];
      lines.splice(start + 1, 0, `${indent}HostName ${hostName}`);
      at = start + 1;
    }

    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const backup = path.join(BACKUP_DIR, `${path.basename(real)}.${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await fsp.copyFile(real, backup);
    const st = await fsp.stat(real);
    const tmp = `${real}.obsync-tmp`;
    // ssh refuses a config that is group/world-writable: keep the mode exactly.
    await fsp.writeFile(tmp, lines.join('\n'), { mode: st.mode & 0o777 });
    await fsp.chmod(tmp, st.mode & 0o777);
    await fsp.rename(tmp, real);
    return { file: real, line: at + 1, from, backup };
  }
  throw new Error(`在 ~/.ssh/config（及其 Include）里没找到 "Host ${alias}" 块`);
}

module.exports = { Breaker, SSH_BIN_DIR, HARD, matchAlias, setSshHostName, isDown };
