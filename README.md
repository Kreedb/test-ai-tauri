# Tauri SSH Terminal

一个最小但有明确分层的 **Tauri 2 + Vue 3 + TypeScript + Vite** SSH 终端模板。

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

## GitHub Pages 与 CI 产物

在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。合并到 `main` 后，`Deploy Web to GitHub Pages` 工作流会发布静态站点，也可以手动触发。

Vite 使用相对资源路径 `base: './'`，同时适用于 `https://<owner>.github.io/<repo>/`、用户主页仓库与自定义域名。默认站点地址为 <https://kreedb.github.io/test-ai-tauri/>，首次部署完成后生效。

`Build and test` 在 PR、`main` 推送和手动触发时分别构建 Web、Linux 与 Windows，并上传 `web`、`linux-x86_64`、`tauri-ssh-template.exe` 三个 Actions artifacts。Windows 产物直接下载为原始 EXE（不再套 ZIP），job 运行于 Ubuntu，显式使用 `cargo-xwin` 与 `x86_64-pc-windows-msvc`；两个锁文件均提交，构建使用 `npm ci` / Cargo `--locked`。

## 架构与扩展边界

```text
src/
  App.vue                    连接表单与页面组合
  components/TerminalPane.vue xterm 渲染、键盘与尺寸事件
  application/               会话状态、异步输入排序、断开与错误处理
  domain/terminal.ts         连接/事件/终端尺寸及 transport 接口
  platform/                  Tauri IPC 适配；Web 不可用适配
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

## 验证

```sh
npm test
npx playwright install chromium       # 首次运行浏览器测试；Linux 缺少系统库时加 --with-deps
npm run test:browser                   # Chromium 中运行真实 Vue + xterm 组件，Web CI 也会执行
npm run build                         # Vue 类型检查 + Vite 构建
cargo fmt --all -- --check
cargo test -p ssh-core --locked        # 不需要 GUI 库；使用回环地址的临时 SSH 服务器
cargo clippy -p ssh-core --all-targets --locked -- -D warnings
cargo test --workspace --locked        # 需要 Linux 桌面构建依赖
```

测试覆盖连接状态与竞态、输入顺序和分片、Web 降级、参数校验、指纹不匹配时不发送密码、显式忽略指纹连接、认证失败、PTY/shell 拒绝、原始字节传输、输出背压、持续输出下的 Ctrl+C、缩放、主动/远端关闭及重连。原生回归测试还检查持续发送数据的握手在超时后关闭套接字，以及服务重置时关闭会话、取消建立中和排队的连接。浏览器测试仅模拟原生 IPC，验证真实 xterm 的二进制鼠标输入、分片 UTF-8 输出与写入背压，以及重连时终端销毁、光标和颜色恢复。测试服务器仅绑定 `127.0.0.1` 的临时端口，不需要外部 SSH 账号。
