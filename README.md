# Tauri SSH Terminal

一个可定制、分层清晰的 **Tauri 2 + Vue 3 + TypeScript + Vite** SSH 终端模板。包含桌面 SSH、可部署的 Web 预览与版本化设置，可作为后续项目的起点。

| 平台 | 产物 | 功能 |
| --- | --- | --- |
| Web | `dist/`，可部署到 GitHub Pages | 共用 UI 与终端预览，不连接 SSH |
| Linux x86_64 | `.deb` | Rust SSH、交互式 PTY、输入输出与窗口缩放 |
| Windows x86_64 | 免安装 `tauri-ssh-template.exe` | 同上；在 Linux 上用 `cargo-xwin` 编译 MSVC 目标 |

静态网页不能直接建立 TCP/SSH 连接，因此 Web 版明确禁用连接，不使用模拟成功的连接或公共代理。真实 SSH 请使用桌面版。

## 快速开始

需要 Node.js 22.12+（推荐 24 LTS）、npm，以及当前稳定版 Rust。桌面开发环境参考 [Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm run dev          # Web：http://127.0.0.1:1420
npm run desktop:dev  # Tauri 桌面开发模式，自动启动 Vite
```

### Linux（Ubuntu 24.04）

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential pkg-config librsvg2-dev patchelf
npm run desktop:linux
```

产物：`target/release/bundle/deb/*.deb`。在带桌面环境的 Ubuntu/Debian 系统上通过 `sudo apt install ./包名.deb` 安装，由包管理器安装 WebKitGTK 等运行依赖。

### 从 Linux 交叉构建 Windows

```sh
sudo apt-get install -y clang lld llvm
rustup target add x86_64-pc-windows-msvc
cargo install --locked --version 0.23.1 cargo-xwin
npm run desktop:windows
```

实际构建命令：

```sh
npm run tauri -- build --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle -- --locked
```

产物：`target/x86_64-pc-windows-msvc/release/tauri-ssh-template.exe`。直接运行，无需安装本程序，不生成 NSIS/MSI 安装包。首次运行 `cargo-xwin` 会下载微软 SDK/CRT，使用即接受其许可证。可用 `XWIN_CACHE_DIR` 指定缓存。

Windows 10/11 需要预先安装 [WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)，便携 EXE 不会自动安装或内嵌该运行时。EXE 未签名，可能出现 SmartScreen 警告。Release 使用体积优化（`opt-level = "s"`、LTO、单 codegen unit、移除符号和 panic unwind），不使用额外压壳工具；编译较慢，panic 时进程直接退出。

## 连接 SSH

1. 在 Linux/Windows 桌面版输入主机、端口、用户名与密码。
2. 通过可信渠道取得服务器主机公钥的 OpenSSH SHA256 指纹。服务器管理员可在服务器上运行：

   ```sh
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
   ```

3. 把输出中的完整 `SHA256:…` 填入指纹栏，然后连接。指纹必须对应服务器实际协商使用的主机密钥；服务器使用其他密钥算法时，应核对该密钥的指纹。
4. 可以运行 shell、交互式程序、Ctrl+C、粘贴文本并调整窗口；点击断开或在 shell 中执行 `exit` 结束会话。

刷新桌面页面会断开当前 SSH 会话并取消正在建立的连接；重新连接会创建全新的终端，清除上一会话的显示和输入状态。

默认在密码发送前验证指纹。也可显式勾选“忽略主机指纹（不安全）”，无需填写指纹即可连接；这会跳过服务器身份验证，可能遭中间人攻击并泄露密码，仅在可信网络临时使用。不要把未经独立核验的 `ssh-keyscan` 结果当成可信指纹。密码不会写入磁盘、日志或浏览器存储，提交后会清空表单；这不代表进程内存中的所有副本能够被安全擦除。

首版仅支持一个会话与密码认证，不含 SSH agent、私钥认证、keyboard-interactive/二次认证、会话持久化或 SFTP；服务器必须允许密码认证和交互式 shell。SSH 数据在 Rust 与 xterm 之间保持原始字节，避免跨网络分片破坏中文或 ANSI 序列。

## 工作区定制

点击右上角 **工作区设置**。先编辑草稿，再点击“应用设置”；取消或按 Escape 不会修改当前配置。Web 预览同样支持设置操作。

| 分组 | 可调整参数 | 默认值 / 范围 |
| --- | --- | --- |
| 外观 | 深色、浅色、跟随系统；强调色；舒适/紧凑密度；侧栏宽度 | 深色、薄荷绿、舒适；320 px（280–420，步长 10） |
| 终端字体 | 本机字体族、字号、行高 | 等宽字体；14 px（10–28）；1（1–2，步长 0.1） |
| 终端行为 | 回滚行数、光标样式/闪烁、屏幕阅读器支持 | 3000（0–50000）；方块、闪烁；阅读器开启 |
| 终端配色 | 午夜、纸张、自定义背景/文字/光标颜色 | 午夜；自定义颜色使用 `#RRGGBB` |
| SSH | TERM、建立连接总超时 | `xterm-256color`；15 秒（1–120） |
| SSH 保活 | 间隔、最大未响应次数 | 30 秒（0–300）；3 次（1–10） |
| SSH 无数据超时 | 协议无活动的超时时间 | 120 秒（0–86400） |

外观和终端设置应用后生效，并重新测量终端、同步远端 PTY 尺寸，不会重建当前会话；降低回滚行数会丢弃超限历史输出。SSH 设置仅用于下次连接。保活间隔与无数据超时设为 `0` 可分别禁用；协议活动包括保活回复，无数据超时不是“用户多久没有敲键盘”。TERM 应与远端支持的终端类型匹配，默认适合 xterm。

设置保存到当前 Web origin / 桌面 WebView 的 `localStorage`（键名 `tauri-ssh.settings.v1`），不跨设备自动同步。存储不可用时本次修改仍生效，并提示导出配置；损坏或不支持版本的配置会回退默认值，直到显式应用设置才覆盖原数据。

**导出配置**下载当前草稿的 JSON；**导入配置**通过校验后载入草稿，仍需点击应用。**恢复默认**同样先作用于草稿。文件上限 32 KB，包含 `version: 1`；缺省分组/字段补默认值，非法值拒绝，未知字段丢弃。配置只包含外观、终端和 SSH 参数，连接地址、用户名、密码、主机指纹与“忽略主机指纹”开关均不保存或导出。

界面还提供连接面板折叠、终端聚焦和本地清屏，底栏显示实际行列数。清屏只清理本地显示/回滚，不向服务器执行命令。

## GitHub Pages 与 CI 产物

在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。合并到 `main` 后，`Build and test` 工作流的部署任务会发布静态站点，也可以手动触发。

Vite 使用相对资源路径 `base: './'`，同时适用于 `https://<owner>.github.io/<repo>/`、用户主页仓库与自定义域名。默认站点地址为 <https://kreedb.github.io/test-ai-tauri/>，首次部署完成后生效。

`Build and test` 在 PR、`main` 推送和手动触发时分别构建 Web、Linux 与 Windows，并上传 `web`、`linux-x86_64`、`tauri-ssh-template.exe` 三个 Actions artifacts。Windows 产物直接下载为原始 EXE（不再套 ZIP），job 运行于 Ubuntu，显式使用 `cargo-xwin` 与 `x86_64-pc-windows-msvc`；两个锁文件均提交，构建使用 `npm ci` / Cargo `--locked`。

## 架构与扩展边界

```text
src/
  App.vue                    工作区组合、主题应用与会话编排
  components/
    ConnectionForm.vue       临时连接信息、验证提示、密码提交即清空
    SettingsPanel.vue        设置草稿、导入导出与原生模态对话框
    TerminalPane.vue         xterm 渲染、选项更新、键盘与尺寸事件
  application/
    terminalSession.ts       会话状态、异步输入排序、断开与错误处理
    settings.ts              设置加载/应用与存储失败提示
  domain/
    terminal.ts              连接/事件/终端尺寸及 transport 接口
    settings.ts              配置类型、默认值、范围、校验与 JSON 格式
  platform/                  Tauri IPC、Web 不可用适配与本地设置存储
  style.css                  主题 token、组件布局与响应式样式
crates/ssh-core/
  src/model.rs               IPC 边界数据与校验，不依赖 Tauri
  src/client.rs              russh 握手、主机指纹、认证、PTY/shell
  src/service.rs             单会话生命周期、串行控制队列、流式输出
src-tauri/
  src/commands.rs            薄 IPC 命令，委托给 ssh-core
  src/lib.rs                 状态与命令装配
  capabilities/              仅本地主窗口的最小权限
.github/workflows/           三端验证/打包与 Pages 发布
```

依赖方向：**视图 → 应用状态 → domain transport ← 平台适配**；桌面调用链为 **Tauri command → SshService → russh**。`ssh-core` 不知道窗口、IPC 或 Vue，因此不安装 GTK 也能单独测试协议逻辑。应用只暴露五个 SSH 命令，不开放本地 shell、文件系统或任意远程页面的 Tauri 权限；CSP 不允许 UI 向外部站点发起网络请求。

输出使用有界 Rust 队列和长等待式 `ssh_read`，xterm 的 `write` 回调完成后才读取下一块，把背压传回 SSH；不使用轮询定时器或无界事件流。为保持初版简单，每次只拉取一块输出，极高吞吐场景可改为带确认的批量传输。

增加业务功能时，在 `domain` 定义必要契约，`application` 管理流程，`platform` 实现平台差异；Rust 业务逻辑放进 `ssh-core`，不要把协议细节写入 Vue 或 Tauri 命令。当前不引入路由、全局状态库、DI 容器或空目录来占位。

### 作为新项目模板

- 调整默认体验：编辑 `src/domain/settings.ts` 的 `defaultSettings()`，主题颜色在 `src/style.css` 的 CSS 变量中集中维护。
- 增加设置：同步更新设置类型、默认值、`validateSettings()`、设置面板和实际使用方；涉及 SSH 时同时更新 `ConnectionOptions`、Rust 校验和协议测试。Rust 独立验证 IPC 参数，不能只信任 HTML 输入约束。
- 配置演进：当前格式为版本 1；新增可选字段可补默认值，破坏性变更应增加版本并提供明确迁移。旧 `ssh_connect` JSON 不提供 `options` 时沿用原默认行为；Rust 调用方构造 `ConnectionRequest` 时需填写 `options: ConnectionOptions::default()`。
- 调整应用名称、标识和初始窗口尺寸：编辑 `src-tauri/tauri.conf.json`；包名/版本同时核对根目录与桌面端 Cargo 配置、`package.json` 和锁文件。权限仍在 `src-tauri/capabilities/` 中按功能显式声明。

## 验证

```sh
npm test
npx playwright install --only-shell chromium  # 首次运行浏览器测试；Linux 缺少系统库时加 --with-deps
npm run test:browser                   # Chromium 中运行真实 Vue + xterm 组件，Web CI 也会执行
npm run build                         # Vue 类型检查 + Vite 构建
npm run test:preview                  # 在 /test-ai-tauri/ 路径下加载构建产物，验证 Web 预览
cargo fmt --all -- --check
cargo test -p ssh-core --locked        # 不需要 GUI 库；使用回环地址的临时 SSH 服务器
cargo clippy -p ssh-core --all-targets --locked -- -D warnings
cargo test --workspace --locked        # 需要 Linux 桌面构建依赖
```

测试覆盖连接状态与竞态、输入顺序和分片、Web 降级、参数校验、指纹不匹配时不发送密码、显式忽略指纹连接、认证失败、PTY/shell 拒绝、原始字节传输、输出背压、持续输出下的 Ctrl+C、缩放、主动/远端关闭及重连。原生回归测试还检查持续发送数据的握手在超时后关闭套接字，以及服务重置时关闭会话、取消建立中和排队的连接；同时验证服务器主动打开的通道被拒绝、PTY 请求 IUTF8 模式、远端信号退出原因会显示，以及发布权限只允许本地 `main` 窗口调用 SSH 命令。浏览器测试仅模拟原生 IPC，验证真实 xterm 的二进制鼠标输入、分片 UTF-8 输出与写入背压，以及重连时终端销毁、光标和颜色恢复；`npm run test:preview` 则在 `/test-ai-tauri/` 前缀下加载构建产物，确认 Web 预览禁用连接且无页面错误。测试服务器仅绑定 `127.0.0.1` 的临时端口，不需要外部 SSH 账号。

设置回归覆盖格式/范围校验、敏感字段剔除、存储失败、草稿取消、导入导出、默认值恢复、重载持久化，以及真实 xterm 在线修改选项后保留输出和同步尺寸；Rust 回环测试验证自定义连接超时与 TERM 实际送达服务端。预览测试还检查浅色主题持久化和 360 px 窄屏布局。
