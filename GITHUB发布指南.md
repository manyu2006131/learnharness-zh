# LearnHarness 简体中文版 · GitHub 发布指南

> 这份指南是给"接手发布的人/AI"看的。按顺序照做即可，不需要懂这个项目的内部实现。

---

## 0. 这是什么

- **软件**：LearnHarness v0.6.1（AI 私教/学习代理），Electron + Next.js 桌面应用。
- **本版本**：社区简体中文汉化版（**非官方**）。只做了界面文案、服务端提示、AI 教学提示词的中文替换，功能与原版一致。
- **原作者**：**Amos Blomqvist**
  - 原仓库：https://github.com/amosblomqvist/learnharness
  - 官网：https://learnharness.ai
  - 许可证：**AGPL-3.0-only**（见根目录 `LICENSE`）
- **汉化版维护者**：发布者本人（GitHub 账号自填）。

### 法律与署名要求（必须遵守）

1. 本项目以 **AGPL-3.0-only** 发布。你发布修改版时：
   - **必须保留** `LICENSE` 文件原样；
   - **必须公开完整源码**（这个压缩包就是源码，直接上传即可）；
   - **必须注明修改**：本版本基于 Amos Blomqvist 的 LearnHarness v0.6.1，于 2026-11-20 做了简体中文汉化；
   - 不得删除原作者版权声明，不得宣称是官方版本。
2. README 顶部建议直接放下面这段（可复制）：

```markdown
> **非官方简体中文版**
>
> 本项目是 [LearnHarness](https://github.com/amosblomqvist/learnharness)（作者：Amos Blomqvist）
> v0.6.1 的社区汉化分支，仅汉化界面与提示词，功能与原版一致。
> 原项目以 AGPL-3.0-only 许可发布；本分支同样以 AGPL-3.0-only 发布，
> 修改时间：2026-11-20。所有版权归原作者所有。
```

---

## 1. 这个包已经做过的隐私清理（上传前仍请自检）

本压缩包在打包时已排除并检查过：

- 不含任何 API Key（各家模型服务一律没有）；
- 不含 `auth.json`、`chatgpt-credentials.json`、`.env` 等凭据文件；
- 不含本机应用数据（`data/` 聊天记录、知识图谱、任务记录）；
- 不含 `node_modules/`、`.next/`、`dist/`、构建缓存、日志、`*.tsbuildinfo`；
- 不含本机绝对路径（Windows 用户目录、安装目录等）和本机模型路由配置；
- 不含本地翻译辅助脚本（`scripts/l10n/`）和生成的插件 SDK（`plugins/*/.sdk/`）。

**上传前自检命令**（在解压后的目录执行，Linux/macOS/Git Bash）：

```bash
grep -rIn -E 'sk-[A-Za-z0-9]{20,}' . --exclude-dir=.git
grep -rIn -E '[A-Z]:\\Users|[A-Z]:\\AppData' . --exclude-dir=.git
find . -iname 'auth.json' -o -iname '*.log' -o -iname '.env*' -o -iname '*.tsbuildinfo'
```

三条命令都**没有输出**才安全。

---

## 2. 上传前必须修改的 3 处（重要！）

### 2.1 自动更新地址：`electron-builder.yml`

文件末尾有：

```yaml
publish:
  - provider: github
    owner: amosblomqvist
    repo: learnharness
```

**不改的后果**：安装中文版的用户点"检查更新"会从原作者仓库下载**英文原版**，直接把中文版覆盖掉。

改成你自己的仓库，例如：

```yaml
publish:
  - provider: github
    owner: 你的GitHub用户名
    repo: 你的仓库名
```

如果你根本不想提供自动更新，也可以删除整个 `publish:` 块，并在应用设置里把自动更新默认关掉（或在 README 里注明"本版本不提供自动更新"）。

### 2.2 上游网站通知：`.github/workflows/notify-website.yml`

这是原作者用来通知他自己官网的流水线，里面有对 `amosblomqvist/learnharness-web` 的调用。**直接删除该文件**，否则发布 Release 时可能报错（缺 `WEBSITE_DISPATCH_TOKEN`）。

### 2.3 发布流水线签名：`.github/workflows/release.yml`（可选）

该流水线用于 macOS 签名/公证，需要原作者的 Apple 证书 Secrets。你如果没有这些 Secrets：
- 建议**不要**用这个流水线发 Release；
- 本地打包后手动创建 Release 上传安装包即可（见第 4 节）。

---

## 3. 创建 GitHub 仓库

1. 新建 **Public** 仓库，建议名字：`learnharness-zh`（明确是中文分支，避免和官方混淆）。
2. 上传本目录全部文件（不要再额外塞 `node_modules`、安装包、聊天数据）。
3. 仓库描述建议：
   `LearnHarness v0.6.1 非官方简体中文汉化版（AGPL-3.0）｜原作者：Amos Blomqvist`
4. 在仓库 About 里加上原仓库链接。

`git` 方式（在本目录执行）：

```bash
git init
git add .
git commit -m "LearnHarness 0.6.1 简体中文汉化版（基于 Amos Blomqvist 原版）"
git branch -M main
git remote add origin https://github.com/你的用户名/learnharness-zh.git
git push -u origin main
```

---

## 4. 构建 Windows 安装包（已在本机验证过的步骤）

环境要求：**Node.js 26**（Node 24 也能构建，CI 用 26）、Windows x64、Git Bash/PowerShell 均可。

```bash
npm ci
npm run build
node scripts/build-server.mjs
npx electron-builder --win --x64
```

产物：`dist/LearnHarness-0.6.1-x64-setup.exe`

说明：
- 构建目录**不要放在 exFAT 盘**上（符号链接/权限会失败），放 NTFS 盘。
- 首次 `npm ci` 会下载约 9 GB 的 `node_modules`，属于正常现象。
- 如果报 Electron 下载失败，设置镜像：
  ```bash
  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  ```

发布到 GitHub Release：

1. 仓库 → Releases → **Draft a new release**；
2. Tag 建议 `v0.6.1-zh.1`；
3. 上传 `dist/LearnHarness-0.6.1-x64-setup.exe`；
4. 如果保留了自动更新配置，同时上传 `dist/latest.yml`（以及 `*.blockmap`）；
5. 标题写清楚：`v0.6.1 简体中文版（非官方）`，正文写授权与原作者信息。

> GitHub 单文件上限 100 MB（仓库内）/ 2 GB（Release 附件）。安装包约 180 MB，**只能放 Release 附件，不能提交进仓库**。

---

## 5. 发布后自检清单

- [ ] 仓库是 Public，源码完整，`LICENSE` 保留
- [ ] README 顶部有"非官方"声明、原作者链接、AGPL 说明
- [ ] `electron-builder.yml` 的 owner/repo 已改成自己的（或已删除 publish）
- [ ] `.github/workflows/notify-website.yml` 已删除
- [ ] Release 里的安装包能正常安装、界面是中文
- [ ] 安装后打开"设置 → 通用 → 检查更新"，确认更新地址指向你自己的仓库或已禁用
- [ ] 用第 1 节的 3 条自检命令复查一遍，无输出

---

## 6. 不要做的事

1. **不要把 API Key 写进代码、README、截图、Release 说明**。本包内没有任何 Key；用户需要自己配置模型服务。
2. **不要提交本机数据**：`data/`（聊天、知识图谱）、`%APPDATA%\LearnHarness\`、任何本地模型代理/路由配置、任何 `auth.json`。
3. **不要用官方名字/官网/图标冒充官方发布**，不要使用 `learnharness.ai` 作为你的下载站。
4. **不要删除或替换** `LICENSE`、原作者版权头。
5. 不要把 `node_modules`、`.next`、`dist`、日志、`tsconfig.tsbuildinfo` 提交进仓库（`.gitignore` 已覆盖大部分，提交前 `git status` 检查一遍）。

---

## 7. 汉化范围（写 Release 说明时可引用）

- `components/`、`app/`、`electron/`：全部界面文案、菜单、空状态、错误提示、无障碍标签；
- `src/server/`、`src/core/`、`src/agent/`：用户可见的服务端提示与错误；
- `src/agent/prompts/`、`src/agent/system-prompt.md`：AI 教学提示词（要求模型用中文教学）；
- 核心插件（编程题/画板/闪卡/富代码块/UI 展示）的名称与描述；
- 主题名、思考档位、快捷键标签等设置页细节；
- 测试断言同步改为中文，`npm test` 可通过（少量与平台相关的环境用例除外）。

未汉化（有意保留）：协议字段、模型名、服务商名、MIME 类型、日志中的技术标识、代码注释。

---

如有问题，请在你自己仓库的 Issues 中说明；**不要**把汉化版的问题提交到原作者仓库。
