# TermDock V0.0.1_1116 验收记录

验收环境为 Windows x64，系统内部版本 26300。桌面测试使用独立的配置目录，串口模拟器和 SSH 测试服务均在本机运行。当前工作区未附 SecureCRT 截图，布局依据需求中的区域和操作说明。

## 本机 Shell 故障定位

旧便携包已启动 WebView2 和后端，并出现 Windows PowerShell 提示符。在窗口中逐键输入后，回归测试停在等待 PowerShell 命令输出。直接运行旧版 `termdock-pty.exe`，向 stdin 发送同样的二进制输入帧，可复现字符丢失，也可观测到帧的长度字段进入 PowerShell 命令行。

链路为 xterm.js 隐藏输入框的键盘事件 → `onData` → WebView2 `postMessage` → WinForms 启动器转发 JSON → Node 会话 → 原生助手解帧 → ConPTY → Shell。Shell 成功启动且工作目录有效时仍能复现，故障定位在助手与 Shell 的标准句柄交接。助手先捕获父进程的 IPC 流，再清空自身标准句柄槽位，由子进程取得伪控制台句柄。输出沿独立管道返回终端。对话框关闭、侧栏开关、标签切换和窗格焦点使用同一个终端焦点恢复入口。

新便携包测试通过真实的 WebView2 宿主、随包 x86 Node.js、x64 ConPTY 助手和 Windows PowerShell。原生串口模块经 COM 枚举和不存在端口的打开错误验证加载。PL2303 的实际 DCB 和电气行为需要实物。

## 上游对照

在 `test-output/upstream-tabby/git-source` 独立检出了稳定发行标签 `v1.0.238`，确认工作树干净，提交为 `54869e108aaa336fdd01bc4de5b160fd8feccf7b`。保存了原版 MIT `LICENSE`。官方 Windows x64 便携包的 SHA-256 为 `56de045fbb5a74d586903367d3f7227276d538281b0068d8132de3318cdd5019`。[Tabby 仓库](https://github.com/Eugeny/tabby) · [固定发行版](https://github.com/Eugeny/tabby/releases/tag/v1.0.238) · [MIT 许可证](https://github.com/Eugeny/tabby/blob/54869e108aaa336fdd01bc4de5b160fd8feccf7b/LICENSE)

上游依赖安装进入下载阶段。此环境缺少其 Windows 打包工作流依赖的 Visual Studio C++ 工具链，官方 Windows ZIP 下载多次超时或截断，原版 Windows 构建及 Shell、SSH 和串口实测待完成。源代码对照确认 Tabby 串口会话传递 XON/XOFF 选项并订阅关闭事件，现有写入调用没有返回串口完成状态。当前版本继续使用 TermDock 的 WebView2、xterm.js、ConPTY、ssh2 和 SerialPort 实现。历史便携包和当前用户配置、日志可继续使用。[Tabby Windows 构建工作流](https://github.com/Eugeny/tabby/blob/54869e108aaa336fdd01bc4de5b160fd8feccf7b/.github/workflows/build.yml) · [Tabby 串口会话实现](https://github.com/Eugeny/tabby/blob/54869e108aaa336fdd01bc4de5b160fd8feccf7b/tabby-serial/src/api.ts)

## 自动化复现

从工作区根目录运行。测试会创建单独的 `test-output` 子目录。

```powershell
npm ci
npm run package:win
npm run test:portable
$env:TERMDOCK_FULL_TIMING = '1'
npm test
Remove-Item Env:TERMDOCK_FULL_TIMING
```

| 项目 | 验收结果与步骤 |
| --- | --- |
| 便携包启动 | 通过。校验 ZIP SHA-256，解包后以独立配置启动，验证运行时首次解压、旧会话和旧命令按钮迁移。 |
| Windows PowerShell | 通过。点击终端区域逐键输入 `echo termdock-ok`，核对独立输出行。按上方向键恢复历史，输入 `Write-Outpu` 后按 Tab 完成命令。验证中文 Unicode 输入和回显、`Start-Sleep -Seconds 30` 的 Ctrl+C 中断、ConPTY 行列同步和 `exit 7` 的退出状态。 |
| 焦点和分屏 | 通过。关闭设置对话框后直接输入，切换 CMD 和 PowerShell 标签。左右分屏后点击 PowerShell 窗格输入，上下分屏后继续输入，关掉分屏后再输入。 |
| CMD | 通过。以指定工作目录和测试环境变量打开 CMD，核对提示符路径和 `echo %TERMDOCK_FIXTURE%`。 |
| SSH 主机密钥和认证 | 通过。环回服务覆盖密码、带口令私钥、首次指纹确认、服务端换钥后在认证前拦截和凭据字段不落盘。 |
| SSH PTY | 通过。环回测试验证 `xterm-256color`NaN`o` 切换窗格，搜索到命令输出。显示宽度从 120 列变到 146 列。测试夹具关闭时出现 node-pty 的 `AttachConsole failed`，发生在断开清理阶段。 |
| SFTP 和本地端口转发 | 通过。环回测试覆盖浏览目录、二进制上传下载，以及经 SSH 回传测试数据后释放本地监听端口。会话导入验证读取现有 `sessions.json` 并去重。 |
| 串口重启任务 | 模拟串口通过。完整计时模式验证首轮等满 60 秒、启动超过下一轮间隔时等待、U-Boot 和 `login:` 门控、两轮恢复、手动输入、断线、实际日志写入故障注入、停止后继续捕获及日志字节边界。 |
| 串口 XON/XOFF | 已核对 Windows 原生绑定源码。应用将 `xon`、`xoff` 置为真并关闭 `rtscts`。绑定设置 DCB 的 `fOutX`、`fInX`，调用 `SetCommState`。需要在 PL2303 实物上核对。 |

此次完整计时测试输出保存在 `test-output/app-lm0giU`。便携包测试通过 `node tests/portable.cjs` 完成。采用普通 Windows 进程权限运行桌面测试，解决工作区沙箱内 Electron AppContainer 文件访问限制。

## 目标环境复测

1. **Windows 10 和 11。** 解压启动，从终端区域执行 `echo termdock-ok`。装有中文输入法时，切换到拼音输入并选词提交，测试组合态下的方向键和 Enter。在 PowerShell 内用 `Write-Output '中文'` 核对回显。分别在标签和分屏间切换。测试 Backspace、Tab 和历史。用已安装的 PowerShell 7 和 WSL 各打开一个会话，核对版本、工作目录、环境变量和退出码。当前环境无可用 WSL，自动测试的中文输入使用浏览器 Unicode 输入事件。
2. **目标 Linux 主机。** 从管理员处取得指纹，以密码、私钥或 Windows SSH Agent 连接。指纹变更时比对新旧值。运行 `tmux new -s termdock`，依次测试 `Ctrl+B %`、`Ctrl+B o`、`Ctrl+B d` 和 `tmux attach -t termdock`。在 tmux 内运行 `vim` 和 `top`，拖动窗口确认备用屏幕和尺寸协商。可使用一个已知内容的二进制文件验收 SFTP。启动本地转发后通过 `127.0.0.1:本地端口` 访问已授权的目标服务，停止后复测监听关闭。
3. **PL2303 实板。** 刷新 COM，选择对应设备，采用 921600 / 8N1 / XON/XOFF。用支持流控的对端发送 XOFF 和 XON，核实 PC 发流暂停与恢复。在两轮重启中比对 `session.raw`、`reboot_*.raw` 和 `events.log`。人为将一轮停在 `login:` 超过 60 秒，再登录并核对只发一条。手动停止后继续向串口输出，确认最后一轮仍追加。拔插后核对任务停止并手动恢复，点击断开后立即用烧录工具打开相同 COM 口。长时测试检查事件中的 `connection_error`、`log_error`、`display_overflow` 和恢复计数。
4. **会话管理。** 建两个分组，标记一个收藏，用会话名及地址搜索。保存关键词 `ERROR, Kernel panic`，重新连接后产生对应输出，核对终端高亮和日志中的原始数据。在 SSH 或本机 Shell 停止再开始录制，检查暂停期间的输出和事件日志。重复导入相同 JSON 时核对新增数为零。

### SecureCRT 对标待实现

- 跳板机、远程及动态端口转发、Telnet。
- SecureCRT 原生会话文件导入、脚本运行、正则高亮规则和完整的分项设置界面。
