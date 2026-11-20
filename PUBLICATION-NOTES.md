# 发布说明与验证范围

## 版本与来源

- 发布版本：v0.6.1-zh.1，非官方简体中文版。
- 原项目：Amos Blomqvist 的 [LearnHarness v0.6.1](https://github.com/amosblomqvist/learnharness/tree/v0.6.1)。
- 许可：AGPL-3.0-only；根目录 LICENSE 和原作者署名保留。
- Windows 安装包由 [GitHub Actions](https://github.com/manyu2006131/learnharness-zh/actions/runs/44715915425) 从发布源码重新构建；本次 Release 未使用早期提供的旧 EXE。
- 应用源码的基础版本保留为 0.6.1，以兼容插件的三段数字版本校验；打包时将桌面安装包版本设置为 0.6.1-zh.1。

## 已执行的自动检查

- Windows 上安装依赖、准备插件并编译应用。
- 运行 smoke-provider-runtime.mjs 和 smoke-server.mjs --electron。
- 生成 Windows x64 EXE，读取打包后的 app.asar 核对桌面版本。
- 读取包内 app-update.yml，核对更新目标为 manyu2006131/learnharness-zh。
- 发布后重新下载附件，使用 SHA256SUMS.txt 校验。
- 检查仓库和 Release 为公开状态，并检查安装包可匿名下载。

上述结果不等于人工安装、完整功能、界面交互或端到端自动升级测试；这些项目尚未人工验证。

## 公开源码的排除项

自动审批拦截了上游测试目录中的真实学习记录、派生会话数据、图谱记录、本机路径、来源元数据以及测试 TLS 私钥。此次公开分发排除了整个 tests/ 目录，保留应用源码、构建配置和资源。因此 npm test 不能直接运行，也不声称上游完整测试套件通过。

Release 中的源码 ZIP 对应构建使用的发布提交。main 后续的说明文档修订不改变已经发布的 EXE 或源码 ZIP。

## 下载与校验

- [Windows EXE](https://github.com/manyu2006131/learnharness-zh/releases/download/v0.6.1-zh.1/LearnHarness-0.6.1-zh.1-x64-setup.exe)
- [对应源码 ZIP](https://github.com/manyu2006131/learnharness-zh/releases/download/v0.6.1-zh.1/LearnHarness-v0.6.1-zh.1-source.zip)
- [SHA256SUMS.txt](https://github.com/manyu2006131/learnharness-zh/releases/download/v0.6.1-zh.1/SHA256SUMS.txt)

Windows EXE SHA-256：

```text
5d2615cbc18477442e7f9f3579dc6c8a1a3fb0a29188544b15e72cc58ecbbb7d
```

源码 ZIP SHA-256：

```text
c96dbaa12e94788b43b13c8f9198c2c77cbb5ea0dfcd6adaae9cba64467f20ed
```
