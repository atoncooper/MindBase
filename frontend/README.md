# ⚠️ 此前端已废弃（DEPRECATED）

本目录 `frontend/` 是 MindBase 的**第一代前端**，自 2026-08 起停止维护，不再接收新功能或修复。

## 改用 frontendv2

当前活跃前端位于 [`../frontendv2/`](../frontendv2/)：

- 技术栈：Next.js 16 + React 19 + Tailwind v4（App Router, standalone）
- 布局：顶部导航栏承载功能，黑白 Apple 风格（弃用 v1 的 dock 栏 + 桌面组件）
- 部署：`docker compose up` —— compose 的 `frontend` 服务现已指向 `frontendv2/Dockerfile`
- 本地开发：`cd frontendv2 && npm install && npm run dev`

## 为什么仍保留此目录

- 历史代码留存，便于对照旧交互与组件实现
- 渐进迁移期间的参考

> **不要在此目录继续开发。** 所有新功能、修复一律在 `frontendv2/` 进行。

## 迁移对照

| 维度 | frontend（v1，废弃） | frontendv2（当前） |
|------|---------------------|-------------------|
| 布局形态 | Dock 栏 + 桌面组件 | 顶部导航栏（Apple 风格） |
| Next.js | 15.x | 16.3 |
| React | 18 | 19 |
| Tailwind | v3 | v4（@theme tokens） |
| Dockerfile | `frontend/Dockerfile`（已停用） | `frontendv2/Dockerfile` |
| CI 触发路径 | `frontend/**`（已停用） | `frontendv2/**` |

## 废弃清单

以下 v1 资产已不再被构建链路引用，仅作存档：

- `frontend/Dockerfile` —— CI 与 compose 均已切到 `frontendv2/Dockerfile`
- `frontend/lib/api.ts` —— v2 使用 `frontendv2/lib/api/` 分模块封装
- `frontend/components/dock-modules/` —— v2 改用顶部导航栏组织
