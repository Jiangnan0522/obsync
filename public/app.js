'use strict';

const DRAG_LOCAL = 'application/x-obsync-local';
const DRAG_REMOTE = 'application/x-obsync-remote';
const DRAG_LINK = 'application/x-obsync-link';

const state = {
  hosts: [],
  sessions: [],
  host: null,          // active host alias
  remoteDir: null,     // remote working dir
  localDir: null,      // local working dir
  localRoots: [],
  remoteRoots: [],
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------

async function api(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const post = (url, body) =>
  api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

let toastTimer;
function toast(msg, isErr) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), isErr ? 7000 : 3000);
}

// ---------------------------------------------------------------------------
// dialogs (never window.confirm/prompt: native dialogs block the whole page)
// ---------------------------------------------------------------------------

function modal(build) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const box = document.createElement('div');
    box.className = 'modal';
    back.appendChild(box);
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    back.onclick = (e) => { if (e.target === back) done(null); };
    document.addEventListener('keydown', onKey);
    build(box, done);
    document.body.appendChild(back);
  });
}

function confirmBox(title, detail, okLabel) {
  return modal((box, done) => {
    box.innerHTML = `<div class="modal-title"></div><div class="modal-detail"></div>
      <div class="modal-acts"><button class="btn" data-v="0">取消</button>
      <button class="btn primary" data-v="1"></button></div>`;
    box.querySelector('.modal-title').textContent = title;
    box.querySelector('.modal-detail').textContent = detail;
    box.querySelector('[data-v="1"]').textContent = okLabel;
    box.querySelectorAll('button').forEach((b) => (b.onclick = () => done(b.dataset.v === '1')));
    box.querySelector('.primary').focus();
  });
}

function promptBox(title, detail, placeholder) {
  return modal((box, done) => {
    box.innerHTML = `<div class="modal-title"></div><div class="modal-detail"></div>
      <input class="modal-input" spellcheck="false">
      <div class="modal-acts"><button class="btn" data-v="0">取消</button>
      <button class="btn ok" data-v="1">打开</button></div>`;
    box.querySelector('.modal-title').textContent = title;
    box.querySelector('.modal-detail').textContent = detail;
    const input = box.querySelector('.modal-input');
    input.placeholder = placeholder;
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value); };
    box.querySelectorAll('button').forEach(
      (b) => (b.onclick = () => done(b.dataset.v === '1' ? input.value : null))
    );
    setTimeout(() => input.focus(), 0);
  });
}


function fmtBytes(n) {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GB';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB';
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + ' KB';
  return n + ' B';
}

// How the link was born. A merge of two populated folders has no direction, so
// it says so instead of inventing an arrow.
const ORIGIN = {
  local:  { cls: 'up',    text: '本地 → 远程' },
  remote: { cls: 'down',  text: '远程 → 本地' },
  merge:  { cls: 'merge', text: '⇄ 合并' },
};

// Preview only — the server owns the real rule (see destName there).
const PREFIX_RE = /^\[from:[^\]]*\]\s*/;
function destNamePreview(source, srcName) {
  let base = srcName;
  while (PREFIX_RE.test(base)) base = base.replace(PREFIX_RE, '');
  const tpl = state.destPrefix ?? '';
  if (!tpl) return base;
  const host = state.hosts.find((h) => h.alias === state.host);
  const label = source === 'local' ? state.localLabel : (host && (host.label || host.alias)) || '';
  return tpl.replace('{name}', label) + base;
}

function warningsText(warnings) {
  const lines = [];
  for (const w of warnings) {
    if (w.type === 'both-exist') {
      lines.push('• 两边都已有同名文件夹，会合并成并集：任一边独有的文件同步给对方，'
        + '不删任何东西；两边都改过的同一文件标记为冲突。');
    }
    if (w.type === 'overlap') {
      lines.push('• 和已有链接重叠：' + w.names.map((n) => `「${n}」`).join('、')
        + ' 位于这个文件夹的上层或下层。两条会话会同时管理同一批文件，'
        + '可能反复触发同步周期或产生莫名的冲突。建议改成只同步其中一层。');
    }
    if (w.type === 'large') {
      const size = w.over ? `超过 ${fmtBytes(w.limit)}` : fmtBytes(w.bytes);
      const files = w.files > w.maxFiles ? `${w.maxFiles}+` : w.files;
      lines.push(`• 体积很大：已统计到 ${size}、${files} 个文件就停止了计数（实际可能远不止）。`
        + '同步这种规模会长时间卡在「扫描中」，并占用远端配额。'
        + '确认它真的是笔记目录，而不是数据集/实验产物/容器镜像。');
    }
  }
  return lines.join('\n\n');
}


// Deleting is only offered for the side the sync created. The dialog names both
// paths explicitly so it is obvious which one is never touched.
function removeDialog(s) {
  const dest = s.origin === 'local'
    ? { side: 'remote', label: '远程', path: s.remotePath, srcLabel: '本地', srcPath: s.localPath }
    : s.origin === 'remote'
      ? { side: 'local', label: '本地', path: s.localPath, srcLabel: '远程', srcPath: s.remotePath }
      : null;

  return modal((box, done) => {
    box.innerHTML = `
      <div class="modal-title"></div>
      <div class="modal-detail"></div>
      <div class="paths"></div>
      <label class="danger-opt" hidden>
        <input type="checkbox">
        <span class="danger-text"></span>
      </label>
      <div class="modal-acts">
        <button class="btn" data-v="0">取消</button>
        <button class="btn primary" data-v="1">断开</button>
      </div>`;

    box.querySelector('.modal-title').textContent = `断开「${s.localName}」的同步？`;
    box.querySelector('.modal-detail').textContent = dest
      ? '默认只断开链接，两端文件都原样保留。'
      : '这条链接是合并创建的（两边原本都有内容），没有「被同步出来的一侧」，因此不提供删除选项。两端文件都会保留。';

    const paths = box.querySelector('.paths');
    const row = (tag, cls, label, p) => {
      const d = document.createElement('div');
      d.className = 'path-row ' + cls;
      d.innerHTML = `<span class="pr-tag"></span><span class="pr-side"></span><code></code>`;
      d.querySelector('.pr-tag').textContent = tag;
      d.querySelector('.pr-side').textContent = label;
      d.querySelector('code').textContent = p;
      paths.appendChild(d);
    };
    if (dest) {
      row('源 · 绝不删除', 'safe', dest.srcLabel, dest.srcPath);
      row('同步生成', 'dest', dest.label, dest.path);
    } else {
      row('保留', 'safe', '本地', s.localPath);
      row('保留', 'safe', '远程', s.remotePath);
    }

    const opt = box.querySelector('.danger-opt');
    const cb = opt.querySelector('input');
    if (dest) {
      opt.hidden = false;
      opt.querySelector('.danger-text').textContent = dest.side === 'local'
        ? `同时删除${dest.label}这一侧的文件夹（移到 macOS 废纸篓，可恢复）`
        : `同时删除${dest.label}这一侧的文件夹（服务器没有回收站，不可恢复）`;
      cb.onchange = () => {
        opt.classList.toggle('armed', cb.checked);
        box.querySelector('.primary').textContent = cb.checked ? '断开并删除' : '断开';
      };
    }

    box.querySelectorAll('.modal-acts button').forEach((b) => {
      b.onclick = () => done(b.dataset.v === '1' ? { ok: true, deleteDest: !!(dest && cb.checked) } : null);
    });
    box.querySelector('.primary').focus();
  });
}


// Add a host the way VS Code does: pick a ~/.ssh/config alias, or type one.
// The connection is tested before the host is saved, so a broken entry never
// makes it into the sidebar.
function addHostDialog(aliases) {
  return modal((box, done) => {
    box.innerHTML = `
      <div class="modal-title">添加主机</div>
      <div class="modal-detail">从 ~/.ssh/config 里选一个，或手动输入。保存前会先测试连接并自动读取远端 HOME 作为默认根目录。</div>
      <select class="modal-input host-pick"></select>
      <input class="modal-input host-manual" spellcheck="false" placeholder="user@host 或 ssh 别名" hidden>
      <input class="modal-input host-label" spellcheck="false" placeholder="显示名（可留空，默认用主机名）">
      <div class="modal-note" hidden></div>
      <div class="modal-acts">
        <button class="btn" data-v="0">取消</button>
        <button class="btn ok" data-v="1">测试并添加</button>
      </div>`;

    const pick = box.querySelector('.host-pick');
    const manual = box.querySelector('.host-manual');
    const label = box.querySelector('.host-label');
    const note = box.querySelector('.modal-note');
    const okBtn = box.querySelector('.ok');

    for (const a of aliases) {
      const o = document.createElement('option');
      o.value = a; o.textContent = a; pick.appendChild(o);
    }
    const other = document.createElement('option');
    other.value = '__manual__';
    other.textContent = aliases.length ? '手动输入…' : '手动输入…（~/.ssh/config 里没有可选项）';
    pick.appendChild(other);
    if (!aliases.length) pick.value = '__manual__';

    const syncMode = () => {
      manual.hidden = pick.value !== '__manual__';
      if (!manual.hidden) manual.focus();
    };
    pick.onchange = syncMode;
    syncMode();

    const submit = async () => {
      const alias = pick.value === '__manual__' ? manual.value.trim() : pick.value;
      if (!alias) { note.hidden = false; note.className = 'modal-note bad'; note.textContent = '请填写主机'; return; }
      okBtn.disabled = true;
      note.hidden = false;
      note.className = 'modal-note';
      note.textContent = `正在连接 ${alias}…（首次连接可能要十几秒）`;
      try {
        const r = await post('/api/hosts', { alias, label: label.value });
        done(r);
      } catch (err) {
        okBtn.disabled = false;
        note.className = 'modal-note bad';
        note.textContent = err.message;
      }
    };

    box.querySelector('[data-v="0"]').onclick = () => done(null);
    okBtn.onclick = submit;
    box.onkeydown = (e) => { if (e.key === 'Enter' && !okBtn.disabled) submit(); };
    setTimeout(() => (manual.hidden ? pick : manual).focus(), 0);
  });
}

async function openAddHost() {
  let aliases = [];
  try { aliases = (await api('/api/ssh-hosts')).aliases; } catch { /* manual entry still works */ }
  const r = await addHostDialog(aliases);
  if (!r) return;
  state.hosts = r.hosts;
  renderAll();
  selectHost(r.host.alias);
  toast(`已添加「${r.host.label}」，根目录 ${r.host.remoteRoots[0]}`);
}

async function removeHostRow(h) {
  const ok = await confirmBox(
    `移除主机「${h.label || h.alias}」？`,
    '只是从这个列表里移掉，不会动服务器上的任何文件，也不改 ~/.ssh/config。之后可以再添加回来。',
    '移除'
  );
  if (!ok) return;
  try {
    const r = await post('/api/hosts/remove', { alias: h.alias });
    state.hosts = r.hosts;
    if (state.host === h.alias) {
      state.host = null;
      if (state.hosts[0]) selectHost(state.hosts[0].alias);
      else { renderAll(); $('remoteBody').innerHTML = '<div class="empty">还没有主机</div>'; }
    } else renderAll();
    toast(`已移除「${h.label || h.alias}」`);
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------------------
// sidebar
// ---------------------------------------------------------------------------

function renderHosts() {
  const box = $('hosts');
  box.innerHTML = '';
  for (const h of state.hosts) {
    const n = state.sessions.filter((s) => s.host === h.alias).length;
    const el = document.createElement('div');
    el.className = 'host' + (h.alias === state.host ? ' active' : '');
    el.innerHTML = `<span class="nm"></span><span class="ct">${n || ''}</span>
      <button class="host-x" title="移除主机">✕</button>`;
    el.querySelector('.nm').textContent = h.label || h.alias;
    el.querySelector('.nm').title = h.alias;
    el.onclick = () => selectHost(h.alias);
    el.querySelector('.host-x').onclick = (e) => { e.stopPropagation(); removeHostRow(h); };
    box.appendChild(el);
  }
  const add = document.createElement('button');
  add.className = 'host-add';
  add.textContent = '＋ 添加主机';
  add.onclick = openAddHost;
  box.appendChild(add);
}

// ---------------------------------------------------------------------------
// breadcrumbs + root switching
// ---------------------------------------------------------------------------

function renderCrumbs(el, full, root, onNav) {
  el.innerHTML = '';
  const rootName = root.split('/').filter(Boolean).pop() || '/';
  const rel = full === root ? '' : full.slice(root.length).replace(/^\//, '');
  const parts = rel ? rel.split('/') : [];

  const mk = (text, target, last) => {
    const b = document.createElement('button');
    b.textContent = text;
    if (last) b.className = 'last';
    else b.onclick = () => onNav(target);
    return b;
  };

  el.appendChild(mk(rootName, root, parts.length === 0));
  let acc = root;
  parts.forEach((p, i) => {
    acc += '/' + p;
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    el.appendChild(sep);
    el.appendChild(mk(p, acc, i === parts.length - 1));
  });
}

function renderRootPicker(el, roots, current, onPick, onOpen) {
  el.innerHTML = '';
  if (roots.length > 1) {
    const sel = document.createElement('select');
    sel.className = 'root-sel';
    for (const r of roots) {
      const o = document.createElement('option');
      o.value = r;
      o.textContent = r.split('/').filter(Boolean).pop() || r;
      o.title = r;
      if (r === current) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => onPick(sel.value);
    el.appendChild(sel);
  }
  const b = document.createElement('button');
  b.className = 'open-btn';
  b.textContent = '打开…';
  b.title = '打开另一个工作目录';
  b.onclick = onOpen;
  el.appendChild(b);
}

// ---------------------------------------------------------------------------
// file rows — both panes are draggable sources
// ---------------------------------------------------------------------------

// A folder is marked either because it *is* a sync root, or because one lives
// somewhere beneath it — the latter is otherwise invisible, and it is exactly
// the case that can produce two sessions managing the same files.
function syncMarks(entryPath, sep, sessions, pathOf) {
  const exact = sessions.some((s) => pathOf(s) === entryPath);
  const inside = exact ? [] : sessions.filter((s) => pathOf(s).startsWith(entryPath + sep));
  return { exact, inside };
}

function fileRow(entry, { dragType, marks }) {
  const row = document.createElement('div');
  row.className = 'row ' + (entry.dir ? 'folder' : 'file');

  // Folders carry a quiet '\u203a' meaning "there is something inside"; files
  // carry nothing at all. Name columns stay flush because .row.file pads left
  // by exactly the chevron's width plus the row gap (see index.html).
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = entry.name;
  if (entry.dir) {
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = '\u203a';
    row.append(ico, nm);
  } else {
    row.append(nm);
  }

  const linked = marks.exact;
  if (linked) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = '已同步';
    row.appendChild(t);
  } else if (marks.inside.length) {
    const t = document.createElement('span');
    t.className = 'tag sub';
    t.textContent = `内含 ${marks.inside.length}`;
    t.title = '这个文件夹里面有已同步的子文件夹：\n'
      + marks.inside.map((s) => '· ' + s.localName).join('\n');
    row.appendChild(t);
  }

  if (entry.dir && dragType && !linked) {
    row.classList.add('draggable');
    row.draggable = true;
    row.ondragstart = (e) => {
      e.dataTransfer.setData(dragType, JSON.stringify(entry));
      e.dataTransfer.effectAllowed = 'copy';
      row.classList.add('dragging');
      state.dragName = entry.name;
      showDropHint(dragType);
    };
    row.ondragend = () => { row.classList.remove('dragging'); showDropHint(null); };
  }
  return row;
}

// While a drag is in flight, say exactly where the folder will land.
function showDropHint(dragType) {
  const el = $('linkHint');
  if (!dragType) {
    el.textContent = '把任意一侧的文件夹拖进来';
    el.classList.remove('active');
    return;
  }
  const toRemote = dragType === DRAG_LOCAL;
  const dest = toRemote ? state.remoteDir : state.localDir;
  const side = toRemote ? '远程' : '本地';
  const name = destNamePreview(toRemote ? 'local' : 'remote', state.dragName || '');
  el.textContent = `↓ 将同步到${side}：${dest}/${name}`;
  el.classList.add('active');
}

// ---------------------------------------------------------------------------
// panes
// ---------------------------------------------------------------------------

async function loadRemote(dir) {
  if (!state.host) return;
  const body = $('remoteBody');
  body.innerHTML = '<div class="empty">读取中…</div>';
  try {
    const q = new URLSearchParams({ host: state.host });
    if (dir) q.set('path', dir);
    const data = await api('/api/remote?' + q);
    state.remoteDir = data.path;
    state.remoteRoots = data.roots;
    renderCrumbs($('remoteCrumbs'), data.path, data.root, loadRemote);
    renderRootPicker($('remoteRoot'), data.roots, data.root, (r) => loadRemote(r), openRemoteRoot);

    const mine = state.sessions.filter((s) => s.host === state.host);
    body.innerHTML = '';
    if (!data.entries.length) {
      body.innerHTML = '<div class="empty">空目录</div>';
      return;
    }
    for (const e of data.entries) {
      const marks = syncMarks(e.path, '/', mine, (s) => s.remotePath);
      const row = fileRow(e, { dragType: DRAG_REMOTE, marks });
      if (e.dir) row.onclick = () => loadRemote(e.path);
      body.appendChild(row);
    }
  } catch (err) {
    body.innerHTML = '<div class="empty">读取失败</div>';
    toast('远程读取失败：' + err.message, true);
  }
}

async function loadLocal(dir) {
  const body = $('localBody');
  try {
    const q = new URLSearchParams();
    if (dir) q.set('path', dir);
    const data = await api('/api/local?' + q);
    state.localDir = data.path;
    state.localRoots = data.roots;
    renderCrumbs($('localCrumbs'), data.path, data.root, loadLocal);
    renderRootPicker($('localRoot'), data.roots, data.root, (r) => loadLocal(r), openLocalRoot);

    body.innerHTML = '';
    if (!data.entries.length) {
      body.innerHTML = '<div class="empty">空目录</div>';
      return;
    }
    for (const e of data.entries) {
      const marks = syncMarks(e.path, '/', state.sessions, (s) => s.localPath);
      const row = fileRow(e, { dragType: DRAG_LOCAL, marks });
      if (e.dir) row.onclick = () => loadLocal(e.path);
      body.appendChild(row);
    }
  } catch (err) {
    body.innerHTML = '<div class="empty">读取失败</div>';
    toast('本地读取失败：' + err.message, true);
  }
}

async function openLocalRoot() {
  const p = await promptBox('打开本地工作目录',
    '输入一个文件夹路径。它会被加入允许列表并保存，之后可以直接从上面的下拉框切换。',
    '~/Desktop/… 或 /Users/…');
  if (!p) return;
  try {
    const r = await post('/api/roots', { side: 'local', path: p });
    await loadLocal(r.path);
    toast(`已打开 ${r.path}`);
  } catch (err) { toast(err.message, true); }
}

async function openRemoteRoot() {
  const p = await promptBox(`打开远端工作目录 · ${state.host}`,
    '输入服务器上的绝对路径。它会被加入允许列表并保存。',
    '/users/… 或 ~/scratch');
  if (!p) return;
  try {
    const r = await post('/api/roots', { side: 'remote', hostAlias: state.host, path: p });
    await loadRemote(r.path);
    toast(`已打开 ${r.path}`);
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------------------
// links pane
// ---------------------------------------------------------------------------

function statusView(s) {
  if (s.paused) return { dot: 'idle', cls: '', text: '已暂停' };
  if (!s.alphaConnected || !s.betaConnected) return { dot: 'bad', cls: 'bad', text: '连接断开 — 检查 SSH / MFA' };
  if (s.conflicts) return { dot: 'bad', cls: 'bad', text: `${s.conflicts} 个冲突待解决` };
  if (s.problems) return { dot: 'warn', cls: 'warn', text: `${s.problems} 个问题` };
  if (s.status === 'watching') return { dot: 'ok live', cls: 'ok', text: '已同步 · 监听中' };
  const zh = {
    'connecting-alpha': '连接本地…', 'connecting-beta': '连接远程…',
    'scanning': '扫描中…', 'waiting-for-rescan': '等待重扫…',
    'reconciling': '比对中…', 'staging-alpha': '暂存本地…',
    'staging-beta': '暂存远程…', 'transitioning': '应用变更…', 'saving': '保存中…',
    'halted-on-root-emptied': '已中止：根目录被清空',
    'halted-on-root-deletion': '已中止：根目录被删除',
    'halted-on-root-type-change': '已中止：根目录类型改变',
  };
  const halted = s.status.startsWith('halted');
  return { dot: halted ? 'bad' : 'warn', cls: halted ? 'bad' : 'warn', text: zh[s.status] || s.status };
}

function renderLinks() {
  const body = $('linksBody');
  const mine = state.sessions.filter((s) => s.host === state.host);
  body.innerHTML = '';

  if (!mine.length) {
    body.innerHTML =
      '<div class="empty">还没有同步链接<br><span style="font-size:11px">从左栏或右栏拖一个文件夹进来</span></div>';
    return;
  }

  for (const s of mine) {
    const v = statusView(s);
    const el = document.createElement('div');
    el.className = 'link';
    el.draggable = true;
    el.innerHTML = `
      <div class="link-top">
        <span class="dot ${v.dot}"></span>
        <span class="link-name"></span>
        <span class="origin"></span>
        <span class="link-acts">
          <button data-a="toggle" title="暂停/恢复">${s.paused ? '▶' : '⏸'}</button>
          <button data-a="flush" title="立即同步">⟳</button>
          <button data-a="terminate" title="断开">✕</button>
        </span>
      </div>
      <div class="link-meta">
        <span class="side"><b>本地</b> <code class="lp"></code></span>
        <span class="side"><b>远程</b> <code class="rp"></code></span>
      </div>
      <div class="link-status ${v.cls}"></div>`;

    el.querySelector('.link-name').textContent = s.localName;
    const o = ORIGIN[s.origin];
    const oEl = el.querySelector('.origin');
    if (o) { oEl.textContent = o.text; oEl.classList.add(o.cls); } else { oEl.remove(); }
    el.querySelector('.lp').textContent = s.localPath;
    el.querySelector('.rp').textContent = s.remotePath;
    el.querySelector('.link-status').textContent = v.text;

    el.ondragstart = (e) => {
      e.dataTransfer.setData(DRAG_LINK, s.name);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    };
    el.ondragend = () => el.classList.remove('dragging');

    el.querySelectorAll('.link-acts button').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const a = b.dataset.a;
        if (a === 'toggle') act(s.name, s.paused ? 'resume' : 'pause');
        else if (a === 'flush') act(s.name, 'flush');
        else if (a === 'terminate') removeLink(s);
      };
    });
    body.appendChild(el);
  }
}

async function act(name, action) {
  try {
    const r = await post(`/api/links/${name}/${action}`);
    state.sessions = r.sessions;
    renderAll();
  } catch (err) { toast(err.message, true); }
}

async function removeLink(s) {
  const res = await removeDialog(s);
  if (!res || !res.ok) return;
  try {
    const r = await post(`/api/links/${s.name}/terminate`, { deleteDest: res.deleteDest });
    state.sessions = r.sessions;
    renderAll();
    toast(r.deleted
      ? (r.deleted.trashed
          ? `已断开并把「${s.localName}」移到废纸篓`
          : `已断开，并删除了远端 ${r.deleted.path}`)
      : `已断开「${s.localName}」，两端文件保留`);
  } catch (err) {
    toast(err.message, true);
  }
  loadRemote(state.remoteDir);
  loadLocal(state.localDir);
}

// ---------------------------------------------------------------------------
// drag & drop — symmetric: either pane can be the source
// ---------------------------------------------------------------------------

function wireDropTargets() {
  const body = $('linksBody');
  const trash = $('trash');
  const isFolder = (e) =>
    e.dataTransfer.types.includes(DRAG_LOCAL) || e.dataTransfer.types.includes(DRAG_REMOTE);
  const isLink = (e) => e.dataTransfer.types.includes(DRAG_LINK);

  body.addEventListener('dragover', (e) => {
    if (!isFolder(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    body.classList.add('drop-ok');
  });
  body.addEventListener('dragleave', (e) => {
    if (!body.contains(e.relatedTarget)) body.classList.remove('drop-ok');
  });
  body.addEventListener('drop', (e) => {
    if (!isFolder(e)) return;
    e.preventDefault();
    body.classList.remove('drop-ok');
    const fromLocal = e.dataTransfer.types.includes(DRAG_LOCAL);
    const entry = JSON.parse(e.dataTransfer.getData(fromLocal ? DRAG_LOCAL : DRAG_REMOTE));
    addLink(entry, fromLocal ? 'local' : 'remote');
  });

  trash.addEventListener('dragover', (e) => {
    if (!isLink(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    trash.classList.add('drop-ok');
  });
  trash.addEventListener('dragleave', () => trash.classList.remove('drop-ok'));
  trash.addEventListener('drop', (e) => {
    if (!isLink(e)) return;
    e.preventDefault();
    trash.classList.remove('drop-ok');
    const s = state.sessions.find((x) => x.name === e.dataTransfer.getData(DRAG_LINK));
    if (s) removeLink(s);
  });
}

// The dropped folder keeps its name; the counterpart is created under the other
// pane's working directory.
async function addLink(entry, source) {
  const body = {
    hostAlias: state.host,
    source,
    sourcePath: entry.path,
    destDir: source === 'local' ? state.remoteDir : state.localDir,
  };
  const done = (made) => {
    toast(source === 'local'
      ? `${entry.name} → ${made.remotePath}`
      : `${entry.name} ← 已拉到 ${made.localPath}`);
    loadRemote(state.remoteDir);
    loadLocal(state.localDir);
  };

  try {
    const r = await post('/api/links', body);
    state.sessions = r.sessions;
    renderAll();
    done(r);
  } catch (err) {
    // The server gathers everything worth knowing into one payload, so this is
    // a single dialog rather than a chain of them.
    let info = null;
    try { info = JSON.parse(err.message); } catch { /* a plain error */ }
    if (!info || info.code !== 'needs-confirm') return toast(err.message, true);

    const ok = await confirmBox(
      `确认同步「${entry.name}」？`,
      `本地：${info.localPath}\n远程：${info.remotePath}\n\n` + warningsText(info.warnings),
      '仍然同步'
    );
    if (!ok) return;
    try {
      const r = await post('/api/links', { ...body, confirmed: true });
      state.sessions = r.sessions;
      renderAll();
      done(r);
    } catch (e2) { toast(e2.message, true); }
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

function renderAll() {
  renderHosts();
  renderLinks();
  const bad = state.sessions.filter((s) => statusView(s).dot.startsWith('bad')).length;
  $('foot').textContent = `${state.sessions.length} 个链接` + (bad ? ` · ${bad} 个异常` : '');
}

function selectHost(alias) {
  if (!alias) return;
  state.host = alias;
  const h = state.hosts.find((x) => x.alias === alias);
  $('remoteHost').textContent = h ? h.label || h.alias : '—';
  state.remoteDir = null;
  renderAll();
  loadRemote(null);
}

async function refresh() {
  try {
    state.sessions = await api('/api/sessions');
    renderAll();
  } catch { /* daemon may be restarting; next tick retries */ }
}

async function boot() {
  wireDropTargets();
  showDropHint(null);
  try {
    const s = await api('/api/state');
    state.hosts = s.hosts;
    state.sessions = s.sessions;
    state.localRoots = s.localRoots;
    state.destPrefix = s.destPrefix;
    state.localLabel = s.localLabel;
    selectHost(s.hosts[0] && s.hosts[0].alias);
    await loadLocal(null);
  } catch (err) {
    toast('启动失败：' + err.message, true);
    return;
  }
  setInterval(refresh, 2000);
}

boot();
