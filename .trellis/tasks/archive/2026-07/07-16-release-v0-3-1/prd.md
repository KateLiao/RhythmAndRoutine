# 发布 v0.3.1

## Goal

将当前已验证的周视图修复正式标记为 v0.3.1，并把 main 分支与版本标签发布到 origin。

## Requirements

- 将 `package.json` 与 `package-lock.json` 的项目版本统一更新为 `0.3.1`。
- 将 README 当前版本更新为 v0.3.1，并新增补丁版本说明；保留 v0.3.0 的完整更新记录与需求文档链接。
- 版本提交前保持工作区仅包含本次发布文件与 Trellis 任务文件。
- 创建 annotated tag `v0.3.1`，推送 `main` 和 `v0.3.1` 到 `origin`。

## Acceptance Criteria

- [x] 三处项目版本声明一致为 `0.3.1`。
- [x] README 清楚说明 v0.3.1 修复了周视图列对齐、日期高亮与布局回归。
- [x] lint、类型检查和生产构建通过。
- [x] `origin/main` 包含 v0.3.1 发布提交。
- [x] 远程存在指向发布提交的 annotated tag `v0.3.1`。

## Out of Scope

- 不重写 v0.3.0 需求文档或历史更新记录。
- 不创建 GitHub Release 页面或额外发布附件。
