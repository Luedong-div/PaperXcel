# PaperXcel

PaperXcel 是一个面向科研阅读与文献管理的本地优先桌面工作区。它把 PDF 阅读、Markdown、笔记、全文检索、AI 助手、知识库和引文图谱放在同一个应用中，适合整理个人文献库、追踪证据链并开展文献综述。

## 主要功能

- **文献库**：拖拽或批量导入 PDF，通过 DOI、arXiv 等标识符添加论文，并使用文件夹、星标和归档整理资料。
- **阅读与笔记**：在 PDF 与 Markdown 阅读器之间切换，编辑并预览论文笔记，可选用 AI 生成或修复 Markdown 内容。
- **全库检索**：对论文正文进行 SQLite FTS5 全文检索，并结合轻量模糊匹配处理前缀、中文子串和少量拼写误差。
- **知识库**：汇总全部论文笔记，支持搜索、Markdown 源码编辑和渲染预览。
- **AI 助手**：连接 OpenAI-compatible API，围绕当前论文或整个资料库进行问答、摘要和研究辅助。
- **引文图谱**：结合 OpenAlex、Crossref 与 PDF 文末书目构建网络，提供相关论文发现、网络分析、JSON 导出和可交互 HTML 导出；Google Scholar 使用独立交互窗口采集标题和元数据，可手动完成验证并连续翻页，关闭窗口后统一导入。
- **Zotero 同步**：支持本地 Zotero 与 Zotero Web API，同步论文元数据和 PDF。
- **预印本回退**：常规来源无法获取全文时，可按需尝试匹配 ChemRxiv 或 arXiv 预印本。

### 文献助手

Agent 先根据问题与已有选区返回公开分析和研究计划，再调用论文检索；检索结果会反馈给模型，由模型决定补充检索还是开始回答，最多进行三轮决策。界面的“分析与计划”来自模型实际返回的内容，执行记录来自实际工具调用与结果；请求等待与收到推理信号分别呈现。

回答按论文隔离并实时显示，支持页码证据、选区图片、附件以及编辑提问和重新生成。停止或连接中断时保留已收到的正文并标记未完成；向上阅读历史时暂停自动滚动，可点击“回到最新消息”恢复跟随。输入 `/compact` 可生成后续追问使用的上下文摘要，保留现有聊天记录（仍遵循每篇最多 200 条的历史上限）。

助手链路分为独立的模型协议解析（`provider-stream.ts`）、请求生命周期（`chat-run.ts`）、论文问答流程（`chat-service.ts`）、前端会话控制（`paperChatController.ts`）和流式视图（`ChatStreamView.tsx`）。正文使用增量与权威快照同步，最终结果统一落入本地历史；失败或取消的消息不会用作后续模型回答的已完成上下文。

## 下载与安装

1. 打开 [Releases](https://github.com/Luedong-div/PaperXcel/releases/latest)。
2. 下载 `PaperXcel-1.0.0-win-x64.zip`。
3. 将压缩包完整解压到可写目录。
4. 运行解压目录中的 `PaperXcel.exe`。
5. 如需使用 AI 功能，在“应用设置”中配置服务地址、API Key 和模型。

## 从源码运行

### 环境要求

- Windows 10/11 x64
- Node.js `>= 22.12.0`
- npm

### 安装与启动

```powershell
git clone https://github.com/Luedong-div/PaperXcel.git
cd PaperXcel
npm ci
npm run dev
```

### 常用命令

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm run test:citation-graph
npm run dist:win
```

## 数据与隐私

- 论文、Markdown、笔记、索引、缓存和应用配置默认保存在程序同级的 `PaperXcel-Data`。
- 只有在用户主动配置并调用 AI、OpenAlex、Crossref、Zotero 等外部服务时，相关请求才会发送到对应服务。

## 许可证

PaperXcel 以 [GNU General Public License v3.0](LICENSE) 发布，SPDX 标识为 `GPL-3.0-only`。

第三方依赖、字体和 PDF.js 资源继续适用各自的许可证。
