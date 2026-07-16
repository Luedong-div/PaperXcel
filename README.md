# PaperXcel

PaperXcel 是一个面向科研阅读与文献管理的本地优先桌面工作区。它把 PDF 阅读、Markdown、笔记、全文检索、AI 助手、知识库和引文图谱放在同一个应用中，适合整理个人文献库、追踪证据链并开展文献综述。

## 主要功能

- **文献库**：拖拽或批量导入 PDF，通过 DOI、arXiv 等标识符添加论文，并使用文件夹、星标和归档整理资料。
- **阅读与笔记**：在 PDF 与 Markdown 阅读器之间切换，编辑并预览论文笔记，可选用 AI 生成或修复 Markdown 内容。
- **全库检索**：对论文正文进行 SQLite FTS5 关键词检索，并使用本地 BGE 模型进行语义检索和结果融合。
- **知识库**：汇总全部论文笔记，支持搜索、Markdown 源码编辑和渲染预览。
- **AI 助手**：连接 OpenAI-compatible API，围绕当前论文或整个资料库进行问答、摘要和研究辅助。
- **引文图谱**：结合 OpenAlex、Crossref 与 PDF 文末书目构建网络，提供相关论文发现、网络分析、JSON 导出和可交互 HTML 导出。
- **Zotero 同步**：支持本地 Zotero 与 Zotero Web API，同步论文元数据和 PDF。
- **预印本回退**：常规来源无法获取全文时，可按需尝试匹配 ChemRxiv 或 arXiv 预印本。

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

## 本地语义检索模型

Windows Release 已包含运行所需的 BGE 模型。源码运行或自行打包时，请准备以下目录：

```text
models/
└── bge-small-zh-v1.5/
    ├── config.json
    ├── model_optimized.onnx
    ├── special_tokens_map.json
    ├── tokenizer.json
    └── tokenizer_config.json
```

模型不可用时，应用仍可运行，但语义检索会降级为关键词检索。

## 数据与隐私

- 论文、Markdown、笔记、索引和应用配置默认保存在本机。
- 只有在用户主动配置并调用 AI、OpenAlex、Crossref、Zotero 等外部服务时，相关请求才会发送到对应服务。

## 许可证

PaperXcel 以 [GNU General Public License v3.0](LICENSE) 发布，SPDX 标识为 `GPL-3.0-only`。

第三方依赖、字体、PDF.js 资源和模型文件继续适用各自的许可证。
