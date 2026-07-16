# Bug Analysis: 周视图修复后的刻度与日程网格纵向堆叠

## 1. Root Cause Category

- **Category**: D - Test Coverage Gap, with an implicit environment assumption.
- **Specific Cause**: `next build` 与仍在运行的 `next dev` 同时写入 `.next`。开发服务器继续提供新 JSX，但对应开发 CSS chunk 中没有 `.week-timeline-body` 网格规则，导致时间刻度列和七天网格按块级元素纵向排列。

## 2. Why Fixes Failed

1. 初次页面验收只检查了表头与日期列边界和底色，没有检查时间刻度位置及 09:00 日程的纵向坐标，因此漏掉了明显回归。
2. 在开发服务器运行时执行生产构建覆盖了共享的 `.next` 输出，验收页面不是一个干净、内部一致的开发产物。
3. 初版 CSS 依赖自动网格放置，没有显式声明刻度列和日程网格必须处于同一网格行，降低了代码审查时发现结构异常的机会。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Process | 生产构建前停止开发服务器；构建后重启开发服务器再做视觉验收 | DONE |
| P0 | Visual check | 同时检查刻度位置、09:00 日程坐标、列边界和状态底色 | DONE |
| P1 | Architecture | 为刻度列和日程网格显式设置 `grid-column` 与 `grid-row` | DONE |
| P1 | Documentation | 将共享 `.next` 的并发限制写入前端质量规范 | DONE |

## 4. Systematic Expansion

- **Similar Issues**: 所有依赖全局 CSS chunk 的页面都可能在并发运行 `next dev` / `next build` 时出现新 DOM 与旧样式混用。
- **Design Improvement**: 需要并行验证时，为 dev 和 build 配置不同输出目录。
- **Process Improvement**: 视觉验收不能只检查原始缺陷，还必须检查变更容器内的关键相邻布局关系。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/frontend/component-guidelines.md`，记录共享滚动容器与显式网格放置规则。
- [x] 更新 `.trellis/spec/frontend/quality-guidelines.md`，记录 Next.js 输出目录限制与日历视觉检查项。
- [x] 当前仓库没有 `src/templates/markdown/spec/`，无需同步模板。
