# 实现计划：Phase B.1 定时 + 手动刷新

## 1. 文档

- [x] 更新 Trellis `prd.md` / `design.md`
- [x] 更新 `docs/v0.3.0 版本需求/新增特性-首页右侧建议卡片.md` §6.2.1
- [x] 保留策略确认：moment 7天/168条，slow 180天/32条

## 2. 后端

- [x] `home-insights-snapshots.ts`：append 写入；`cleanupOldInsightSnapshots`
- [x] `home-insights.ts`：GET 只读最新；cold_start；`regenerateHomeInsightTarget`
- [x] `POST /api/home/insights/regenerate`
- [x] `GET /api/cron/home-insights`（hourly moment + Wed 08:00 / Sun 20:00 slow）
- [x] 移除 schedule/reviews 的 invalidate 调用
- [x] Prisma migration：`trigger` 字段
- [x] AI 失败时不覆盖已有 AI 快照

## 3. 前端

- [x] `homeInsightsApi.regenerate(target)`
- [x] 三卡刷新按钮 + `generatedAt` 展示
- [x] `meta` 字段对接

## 4. 验证

```bash
npm run typecheck
npm run lint
npm run build
```

手动：
- 连刷 5 次 GET，文案不变
- 手动更新 moment/slow 各一次
- 配置 cron 调用 `/api/cron/home-insights`
