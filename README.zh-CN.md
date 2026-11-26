# obsync

给 [mutagen](https://mutagen.io) 同步会话用的三栏拖放式 GUI。
适用于这种场景：笔记在你的笔记本上，活儿却是在远端机器上干的——HPC 集群、
GPU 服务器、VPS。

[English](README.md)

```
 主机  │   远端          │    链接     │    本地       │
       │  working dir ───┼──→ 拖放 ←───┼── working dir │
```

两侧文件面板是对称的。面板当前显示的目录，就是那一侧的 **working dir**。
把文件夹从任意一侧拖出去，对应的副本会在*另一侧*的 working dir 下建好，
之后两者保持同步——双向、持续，并带冲突检测。

没有 Electron，没有构建步骤，没有 npm 依赖。一个约 900 行、只用标准库的
Node 服务端，加一个单页前端。

## 为什么不直接用 rsync / scp / git 仓库

那些是传输，得你自己去跑。mutagen 是常驻进程：它盯着两端，改动一发生就同步过去。
mutagen 缺的是一种*看见*自己有哪些会话的办法，以及不用敲两个绝对路径就能建一个会话。
这就是 obsync 补上的部分。

## 安装

需要 macOS、[Node.js](https://nodejs.org) 18+ 和
[mutagen](https://mutagen.io/documentation/introduction/installation) 0.18+。

```sh
git clone https://github.com/Jiangnan0522/obsync.git
cd obsync
./install.sh
```

`install.sh` 会检查依赖、把一份起步配置写到 `~/.obsync/config.json`、
把 `obsync` 命令装进 `~/.local/bin`，并可选地注册一个 LaunchAgent，
让服务端开机登录时自动启动。

然后：

```sh
obsync              # start the server (if needed) and open the UI
obsync status       # is it running? is it managed by launchd?
obsync stop | restart | log | path
```

从侧边栏添加第一台主机——obsync 会读 `~/.ssh/config`（并跟进 `Include`），
把找到的别名列出来供你选。

**端口、密钥、ProxyJump 之类的东西都写在 `~/.ssh/config` 里。**
obsync 是调用系统的 `ssh`，所以你在那边配的一切都会被继承。
密钥认证必须能免交互通过：同步守护进程在后台跑，没法回答密码提示。

## 使用

- **建立链接** —— 把文件夹从任一侧拖到中间。拖*本地*文件夹是往上推，
  拖*远端*文件夹是往下拉。拖动过程中，中间面板会显示确切的目的地路径。
- **切换 working dir** —— 点进文件夹，或者用面包屑导航。面板标题栏的
  "Open…" 接受任意路径；该路径会被加进这一侧的允许列表并持久化。
  两侧的 working dir 下次启动时都会恢复。
- **文件夹标签** —— `synced` 表示这个文件夹*就是*某个链接的根。
  `contains N`（虚线）表示它下面某处有链接的根。
- **方向徽章** —— 每张链接卡片会标明内容最初是从哪边来的：`local → remote`、
  `remote → local`，或者 `merged`——两边本来就都有内容，说哪个方向都不算实话。
- **目的地前缀** —— 同步*新建出来*的那一侧会命名为 `[from * <origin>] <name>`，
  一眼就能看出它不是手工建的。来回同步不会把前缀套娃。
- **断开** —— 把卡片拖到垃圾桶区域，或点 `✕`。默认两侧都保留；
  有个复选框可以顺带删掉同步新建出来的那一侧。

## 安全

同步工具是会删文件的。以下是 obsync 遵守的规则。

**先终止，再删除，并且要验证确实终止了。** 会话还活着的时候去删目的地，
删除动作会被同步到*源*上。所以流程是：终止 → 重新查询、确认会话真的没了 →
到这一步才动文件。如果这个确认没通过，删除操作直接放弃。

**只有被创建出来的那一侧可删。** 哪一侧是被创建的，取决于创建时写入的
`obsync-src` 标签。`merged` 链接完全不提供删除：两侧都早于这次同步存在，
所以谁都不是副本。路径校验跑在拆除*之前*，所以一个被拒绝的请求不会让你
落到"会话已经拆了"的状态。

**本地删除进废纸篓。** 远端删除是 `rm -rf`，而且界面会明说。如果废纸篓
在另一个卷上（`rename` 不能跨卷），删除会被拒绝，而不是悄悄降级成一个
不可恢复的删除。

**根目录是允许列表。** 每个路径都必须落在你打开过的某个目录里面。
这不只是防手滑：浏览器里任何一个页面都能往 `127.0.0.1` 发 POST。
JSON 的 content type 会触发一次永远得不到回应的 CORS 预检，但用
`text/plain` 携带 JSON 体属于"简单请求"，能直接放行——所以会改状态的
请求还会检查 `Origin`。

**不拼 shell 字符串。** 子进程一律走 `execFile(cmd, [args])`。唯一一处必须
让远端 shell 去解释路径的地方，做了单引号转义。带空格、`&`、中日韩文字和
emoji 的文件夹名都能原样往返。

## 开发过程中的一些记录

**mutagen 就是数据库。** 没有状态文件。会话被打上 `obsync=true` 标签，
外加 `obsync-host` 和 `obsync-src`，UI 用 `--label-selector` 把它们列出来。
杀掉服务端、重启机器——同步照常进行，而你用 mutagen CLI 手工建的会话
永远不会被碰到。

**会话名是哈希。** mutagen 的名字必须匹配 `[A-Za-z0-9][-A-Za-z0-9_.]*`，
可现实里的文件夹叫 `📊 读书笔记`。所以名字取成 `obsync-<10 hex>`，
由路径推导而来；显示用的名字则从路径里读回来。

**远端监听靠轮询，而且这是对的。** 本地端用 FSEvents，约 2 秒内就能同步过去。
网络文件系统在别的节点写入时，是不能指望它把 inotify 事件送到你这儿的，
所以 mutagen 对远端采用轮询（默认 10 秒；用 `remotePollSeconds` 设置）。

**永远用 `find -H`。** 集群的 home 目录非常经常是符号链接
（`/users/x -> ../../volumes/...`），而普通的 `find` 不会遍历起始点，
结果什么都返回不了。`-H` 只对起始点解引用。远端命令还会先 `test -d`，
失败时输出一个哨兵值——否则每一个错误都会被渲染成"空目录"。


**绝不要让 mutagen 和你共用同一个 ssh ControlMaster。** 连接复用能让 obsync 自己的目录
列举快约 100 倍，所以很容易想在 `~/.ssh/config` 里给同步主机直接打开它。不要这么做：
mutagen 的**每条同步会话都持有一个永不关闭的 ssh 通道**，master 因此永远不空闲、
`ControlPersist` 永远回收不了它，而异常断开泄漏的通道只增不减，攒到服务端的
`MaxSessions` 上限后就会拒绝一切新通道。唯一的外在症状是会话卡在"连接中"——
而你手动 `ssh` 同一台主机**照样成功**（它复用的是已经建立的通道），会把排查引向完全
错误的方向。obsync 把自己的调用复用在 `~/.obsync/` 下的独立 socket 上，
mutagen 的连接则保持直连。

**体积探测会提前退出。** 建立链接之前会先测量源的大小，超过阈值
（默认 5 MB / 2000 个文件）就弹提示。探测一越过限额就立刻停下——
`awk` 退出，`find` 吃到 SIGPIPE——所以对一个 5 MB 的文件夹和一个 188 GB 的
文件夹，开销是一样的。实测：0.12 秒。

**重叠的根目录会被标出来。** 如果 `A/` 已经在同步，你又去同步 `A/B/`，
就会有两个会话管着同一批文件，互相回放对方的写入。拖动一个和已有链接
存在嵌套关系的文件夹时，会给你警告。

## 熔断 —— 别让 IP 被封

OpenSSH ≥ 9.8 的 sshd 有 `PerSourcePenalties`：凡是**认证前**就结束的连接（客户端超时、
放弃、认证失败）都会给来源 IP 记罚时；攒够之后，这个 IP 的**所有**新连接（包括你的终端和
VS Code）都会被直接拒绝（"Not allowed at this time"），最长 10 分钟。mutagen 正好是罚时
制造机：它写死了 `-oConnectTimeout=5 -oServerAliveCountMax=1`，每个会话每 15 秒重连一次，
永不停止。登录节点一慢、六个会话，几分钟就能把 IP 封掉。

obsync 按**服务器**做熔断（别名先用 `ssh -G` 解析；HostName 相同的两个别名是同一个 sshd、
同一笔罚时）：

- **熔断**：某个会话连续 35 秒连不上远端（≈ 两次重连失败），或者任何 ssh 输出里出现
  `Not allowed at this time` / `banner exchange` / `kex_exchange_identification`，立刻
  `mutagen sync pause` 这台服务器上的全部 obsync 会话；obsync 自己对它的目录浏览也会被拒绝。
- **退避**：2 → 5 → 10 → 20 分钟（之后保持 20）；被封过则至少等 10 分钟。DNS / 网络不可达
  的失败根本到不了服务器，不会加罚时，所以每分钟重试一次、不升级。
- **探测**：只发一次真正完成登录的 `ssh -o BatchMode=yes -o ConnectTimeout=30 <别名> true`。
  绝不用 `nc` 或"读完 banner 就断开"的 socket 检测——在 sshd 看来那本身就是认证前断开，
  照样加罚时。也绝不并发探测。
- **恢复**：只恢复它暂停的会话，每 8 秒一个；中途再失败就再次熔断。
- **切换节点**（可选）：给主机配 `"failover": ["login1…", "login2…"]`，中栏会出现
  「切换节点」：暂停 → 改该别名所在 `~/.ssh/config` 块里的 `HostName`（备份到
  `~/.obsync/ssh-config-backups/`）→ 探测 → 恢复。10 分钟内封过你的节点会拒绝切过去。
  `"breaker": {"autoFailover": true}` 可在被封时自动切换。

每次暂停 / 探测 / 恢复 / 切换都会连同触发它的原始报错写进 `~/.obsync/breaker.log`
（`obsync events` 查看）；mutagen 守护进程自己不写日志。参数在配置的 `"breaker"` 下
（`tripAfterSeconds`、`backoffMinutes`、`bannedMinutes`、`staggerSeconds`、`enabled` …）。

**ssh 包装脚本。** 命令行上的 `-o` 优先于 `~/.ssh/config`，所以 mutagen 的超时在配置文件里
改不了。mutagen 0.18 在*守护进程*环境里有 `MUTAGEN_SSH_PATH`（一个目录）时，会从那里找
`ssh` 和 `scp`。`obsync ssh-wrapper on` 把 `libexec/ssh-wrapper.sh` 装到
`~/.obsync/ssh-bin/`，并把这个变量加进 mutagen 的 LaunchAgent。包装脚本把
`ConnectTimeout 5→30`、`ServerAliveInterval 10→15`、`ServerAliveCountMax 1→4`，其余参数
原样 `exec /usr/bin/ssh`，并把 ssh 的 stderr 复制一份到 `~/.obsync/ssh-wrapper.log`。
这份日志很关键：mutagen 会**丢弃**每次重连失败的错误（`lastError` 一直停在最初的
`unexpected EOF`），熔断器只能从这里看到封禁信息。`obsync ssh-wrapper off` 可撤销；
执行过 `mutagen daemon register`（会重写 plist）之后要再 `on` 一次。

## 配置 —— `~/.obsync/config.json`

| 键 | 含义 |
|---|---|
| `port` | HTTP 端口，仅监听回环地址（默认 7777） |
| `localRoots[]` | obsync 可以操作的本地目录；"Open…" 会往里追加 |
| `hosts[]` | `alias` 必须能通过 `~/.ssh/config` 解析（或者本身就是 `user@host`）；`remoteRoots[]` 是它的允许列表 |
| `syncMode` | `two-way-safe`（默认）、`one-way-safe`、… |
| `ignore[]` | mutagen 的忽略规则 |
| `remotePollSeconds` | 远端轮询间隔（默认 10） |
| `destPrefix` | 目的地命名模板，默认 `"[from * {name}] "`；填 `""` 可禁用 |
| `localLabel` | 在该前缀里本地这一侧的称呼 |
| `warnSizeMB` / `warnFileCount` | 体积警告阈值；`0` 表示禁用 |
| `hosts[].failover[]` | 这个别名可以切换到的兄弟节点 HostName（共享文件系统） |
| `breaker` | 熔断参数，见上文 |

`lastLocalDir` 和 `hosts[].lastRemoteDir` 由程序自动写入。

## 排查问题

| 现象 | 怎么办 |
|---|---|
| 卡片显示 "disconnected" | SSH 连不上了。如果你的集群要定期 MFA，去它的门户重新认证一下；会话会自己恢复 |
| "N conflicts" | 两边改了同一个文件。`mutagen sync list --long <name>` |
| 一直卡在 "scanning" | 文件夹太大了。新建链接时会就此警告，已有的链接不会再复查 |
| 文件数对不上 | 先看差异是不是落在 `ignore` 里（`.obsidian/`、`.git/`、…）。用 `find . -type f` 比对文件名，别比数字 |
| 链接不见了 | 数据没丢；两侧的文件都还在。拖回去就行——会出现合并提示 |
| 链接卡在 "connecting"，但 `ssh <主机>` 却正常 | ssh ControlMaster 的通道用尽了。把该主机 `~/.ssh/config` 块里的 `ControlMaster` 去掉并删除它的 socket；obsync 自己会做复用 |
| "Not allowed at this time" / 所有 ssh 都被拒 | sshd 的 PerSourcePenalties 封了你的 IP。别在那台节点上继续重试；等 ≥10 分钟或切换节点。见「熔断」和 `obsync events` |
| 卡片显示「已暂停 · 熔断保护」 | 服务器熔断期间的正常状态，会自动探测并恢复；「立即探测」可提前探测 |
| UI 打不开 | `obsync log` |

## 许可证

MIT
