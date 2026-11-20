# 青蛙跳板 · FrogBoard

青蛙跳板，一个剪切板工具，能翻译，能截图，能总结和生成文字，减少应用之间的切换，提高工作效率。

Windows 桌面应用。用 Rust 与 Tauri 2 连接系统选区、截图和剪贴板，用 React 和 TypeScript 实现操作面板与标注编辑器。

## 开始使用

运行 `frogboard.exe` 或安装 Windows x64 安装包。首次启动打开工作台；关闭窗口后可以从系统托盘继续使用。托盘菜单提供退出入口。

| 默认快捷键 | 用途 |
| --- | --- |
| `Ctrl+Alt+A` | 框选截图，圈画、加箭头、写字、打码，回车复制或另存 PNG |
| `Ctrl+Alt+T` | 翻译当前选区；取不到文字时，框选后直接翻译图片 |
| `Ctrl+Alt+V` | 读取当前剪贴板，按文本或图片展示可用操作 |

截图快捷键可能与微信等软件冲突。打开「设置 → 快捷键与划词」即可重新绑定。划词按钮可独立关闭。剪贴板面板固定本次读取的内容，点「重新读取」切换到新内容。

**已有图片也能标注。** 从浏览器或聊天复制图片，呼出面板，点「继续标注」。复制、保存和图片模型操作都会使用合成后的画面。实心遮挡适合隐藏账号等信息。

## 配置模型与动作

1. 打开「设置 → 模型与动作」，添加模型连接，填写服务地址、模型 ID 和服务所需的 API Key。接口需要兼容 Chat Completions。支持 HTTP 和 HTTPS，可填写域名、IP 和自定义端口。使用 HTTP 时，请求内容和密钥会明文传输。
2. 指定文本默认模型。对于支持看图的模型，启用图片能力并指定默认视觉模型，保存设置。
3. 在「提示词操作」编辑翻译、提取文字、润色或总结，也可以添加自己的动作。用示例内容试跑后，再用于工作材料。

API 密钥使用 Windows 凭据管理器保存。截图和读取剪贴板都在本机完成，触发模型动作时，才会把当前文字或合成后的图片发送到配置的服务。截图、复制、保存可以离线使用。

## 本地开发

在 Windows x64 上准备 Node.js 24、Rust stable MSVC、Visual Studio 2022 C++ 生成工具（含 Windows SDK）以及 WebView2。

```powershell
npm ci
npm run desktop
```

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 在浏览器预览前端；系统能力通过桌面版运行 |
| `npm test` | 验证截图选区与标注模型 |
| `npm run build` | TypeScript 检查与前端发布构建 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 运行原生模块测试 |
| `npm run package` | 构建 Windows x64 exe 及当前用户 NSIS 安装包 |
| `.\scripts\windows-smoke.ps1` | 在交互式 Windows 桌面启动已打包程序，检查工作台、设置和截图编辑入口 |

发布产物位于 `src-tauri/target/release/frogboard.exe` 与 `src-tauri/target/release/bundle/nsis/`。运行依赖系统 WebView2。首次在干净机器构建可能需要下载 NSIS 与 WebView2 引导程序。

## 项目导航

| 目录 | 职责 |
| --- | --- |
| `src/` | 工作台、快捷键设置、桌面事件和视图切换 |
| `src/editor/` | 框选、标注对象、历史记录、画布与合成导出 |
| `src/models/` | 模型配置、提示词、动作试跑 |
| `src-tauri/src/desktop/` | Windows 选区、截图、剪贴板与窗口定位 |
| `src-tauri/src/models.rs`、`src-tauri/src/models/` | 服务请求、配置保存、凭据 |
| `src-tauri/src/shell.rs` | 托盘、单实例、快捷键与生命周期 |

交互决策、技术边界与参考实现记录在[设计文档](docs/design.md)。每轮开发的完成情况、已知限制与手工验收记录在[迭代记录](docs/iterations.md)。
