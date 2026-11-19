# TermDock V0.0.4_1119 验收

以 `V0.0.3_1118` 为回归基线，在 Windows x64（build 26300）验证。Windows 便携包与源码包使用同一版本。ADB 随包提供，三件二进制与附件和上游 Windows Platform-Tools 29.0.5 逐一匹配。

## 构建和测试

在 Windows x64 的项目根目录执行以下命令。

```powershell
npm ci
npm test
npm run test:ai
npm run test:ai-chat
npm run test:compact
npm run test:adb
npm run package:win
npm run test:portable
npm run test:portable-ai
npm run test:portable-chat
npm run package:source
```

串口完整计时回归使用 `$env:TERMDOCK_FULL_TIMING = '1'` 后运行 `npm test`。可选的 tmux 回归使用带 `tmux` 和 `python` 的 [MSYS2](https://www.msys2.org/)，把 `$env:TERMDOCK_TMUX_MSYS` 指向其根目录，再运行 `node tests/tmux.cjs`。脚本将逐层测量写入 `test-output/tmux-*/measurements.json`。

解压便携包全部文件后运行 `TermDock\TermDock.exe`。对照 `.sha256` 核对两个 ZIP。ADB 来源见 `vendor/adb/NOTICE.txt`，上游许可证说明随包保存在 `vendor/adb/UPSTREAM-NOTICE.txt`。

## 本地验收结果

| 反馈项 | 已验证结果 |
| --- | --- |
| SSH 与 tmux 尺寸 | 正式便携包经环回 SSH 连接真实 tmux 3.8。客户端行列、SSH PTY 行列及终端像素尺寸同步。通过最大化、还原、会话栏、左右和上下分屏、窗格分隔线及 AI 栏缩放。`Ctrl+B %` 分窗格、`Ctrl+B o` 切换、`Ctrl+B d` 分离并重接通过。 |
| AI 提问与等待进度 | 持续串口输出和半行手动输入时，普通问答均完成。验证加载计时、实际 SSE 推理和正文阶段、增量正文、一次性返回、降级、取消、超时和重试。Enter 提交、Alt+Enter 换行及组合输入事件通过。 |
| AI 配置保存 | **模型全名** 下拉框同时列出 GLM 和 DeepSeek 两个预设，选择后请求使用完整名称。在 Windows 便携版验证 DPAPI 保存、掩码、点击显示、重启读取及清除。两个入口读取同一份 Key。自定义模型去除首尾空白、去重并在重启后用于请求。 |
| SSH 密码 | 环回 SSH 通过保存、更换、会话设置掩码和显示、关闭程序后重启复用及清除。更换主机密钥时在发送认证前拦截。 |
| AI 串口授权与提问 | 模拟 COM3 和 COM12 验证目标隔离、批准、拒绝、关闭确认、手动接管、断线与日志失败。模拟等待 `~ #` 后写入 `load_mbd.sh`，至少等待 2 秒再写 `run_pipeline 2`，顺序与回显匹配。确认、串口选择、单选、多选、文本回答均传回原任务，提示符超时会跳过剩余写入。 |
| AI 助手与栏宽 | **更多** 中统一使用 **AI 助手** 打开对话。终端选区可在对话内分析。便携包的右侧 AI 栏向左和向右拖动后，终端和 tmux 行列随之更新。 |
| 思考挡位 | 模拟 HTTP 核对默认省略 `reasoning_effort`、快速 `low`、标准 `high`、深度 `max`。同一自动操作轮次沿用发送时的值。服务明确拒绝后禁用对应挡位并保留原问题。 |
| Windows 文件拖入 | PowerShell / CMD 接收按原序排列的纯文本绝对路径，保留反斜杠、中文、空格和单引号。拖入后仍可编辑或取消，命令等待手动 Enter。 |
| Windows ADB | 设置页提供工具目录。工具栏 **ADB** 和 **更多 → ADB 命令** 将 `adb ` 填入当前 PowerShell，手动补全与执行。真实 `adb version` 返回 `1.0.41` / `29.0.5-5949299`，配置含中文和空格的工具目录后重启也能调用。设备枚举此前在 Windows 实际运行并返回空列表，拉取使用模拟设备验证。 |
| 取消分屏 | 两种布局均通过工具栏 **取消分屏**，活动窗格恢复单窗格，其他标签和滚动回看继续可用。 |
| 当前会话重连 | 同一按钮随活动窗格切换为 **断开** 或 **连接**。验证退出后重新打开 PowerShell、用原目标和保存的密码重连 SSH，以及模拟串口重连。 |

原功能回归通过本机 PowerShell / CMD、ConPTY 逐键输入与缩放、Tab 补全、历史、Ctrl+C、UTF-8、SSH 指纹验证和私钥、SFTP、端口转发、会话迁移、命令按钮和日志开关。模拟串口用默认 60 秒间隔跑完两轮重启，覆盖长于 60 秒的启动、`login:`、断线、磁盘故障及停止后继续记录末轮原始日志。

### tmux 尺寸抽样

| 操作 | xterm.js、SSH PTY 和 tmux 客户端 | tmux 窗口 |
| --- | --- | --- |
| 首次连接或还原 | 120 × 35 | 120 × 34 |
| 最大化 | 256 × 61 | 256 × 60 |
| 收起会话栏 | 147 × 35 | 147 × 34 |
| AI 栏加宽 / 缩窄 | 96 × 35 / 113 × 35 | 96 × 34 / 113 × 34 |
| 左右分屏 / 拖宽左侧 | 72 × 35 / 83 × 35 | 72 × 34 / 83 × 34 |
| 上下分屏 / 增高上方 | 147 × 19 / 147 × 22 | 147 × 18 / 147 × 21 |
| 服务端固定窗口 | 147 × 35 | 40 × 10 |
| 恢复自动尺寸 / 重接 | 147 × 35 | 147 × 34 |

早期用 Windows 控制台承载 tmux 的测试曾出现 SSH PTY 已收到 `120 × 35`、tmux 客户端仍为 `120 × 33`。使用 POSIX PTY 测试端后，上述采样能逐层对齐。TermDock 在窗格布局稳定后重新 fit，并在连接建立后同步实际尺寸。固定窗口的验证将 tmux 切换为 `window-size manual`，再恢复 `latest`，复现了客户端尺寸正常时服务端仍可留下空白。较小的其他 tmux 客户端也可能影响窗口大小，取决于 `window-size` 设置。[tmux 窗口尺寸](https://github.com/tmux/tmux/wiki/Advanced-Use#window-sizes)

## 现场复核

- 本机仅枚举到 COM1。待在 Windows 10、PL2303 实板、用户的实际 Linux SSH 主机和 Android 设备上复核。内网 AI 流式输出和模型挡位需要有权限的 Key；本地测试使用模拟服务。真实输入法选词需要人工复核。
- 在 SSH 新建和接入 tmux，用 `tmux display-message -p '#{client_width}x#{client_height} #{window_width}x#{window_height}'` 核对客户端和窗口。最大化、还原、横竖分屏、拖分隔线和开合 AI 栏分别检查。tmux 一行状态栏时，窗口内容通常比客户端少一行。`tmux show-options -w window-size` 可区分服务端固定窗口大小和客户端尺寸问题。
- 在设置保存同一份有效 AI Key，检查两处掩码和显示按钮。新增并选择自定义模型，重启后使用保存的 Key 测试连接。分别发送默认、快速、标准和深度消息，记录内网服务实际接受的挡位。
- 使用串口持续输出及手动输入半条命令分别验证普通问答。自动操作在授权卡片中核对目标 COM 口和写入步骤。拒绝或关闭卡片后应无写入；批准后观察实板回显。用实际中文输入法确认 Enter 选词和 Alt+Enter 换行。
- 在设置选择含中文和空格的 ADB 目录，新开本机 PowerShell，验证 `Get-Command adb`。点击右上角 **ADB**，补全 `version`，再按 Enter。连接已授权的 Android 设备，用同一入口补全 `devices -l` 或 `-s <设备序列号> pull <设备端路径> <本地目录>`。
