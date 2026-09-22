# Folder Organizer Implementation Plan

**Goal:** 提供可用的本地文件与文件夹标签分类、预览、移动、撤销工具。
**Architecture:** 原生 HTTP 服务、独立文件系统整理模块、TypeSafe SDK 适配模块、无构建依赖的网页。
**Tech Stack:** Node.js 22、@typesafe-ai/sdk、原生 HTML/CSS/JavaScript、node:test。
**Spec:** docs/superpowers/specs/2026-09-21-folder-organizer-design.md

## Constraints
只移动用户扫描的直属普通文件和文件夹；分类固定；不覆盖；不读取文件内容；仅本机服务；API Key 不下发浏览器。

## Tasks
- [x] 文件系统模块：临时目录测试与 `Organizer.scan(root)`、`move(scanId, selections)`、`history()`、`undo(id)` 已完成，覆盖冲突、目录身份、符号链接、持久化故障恢复、重启撤销和重复请求。
- [x] 分类模块：完成 SDK 请求的 state 与 choice 映射、低置信度、非法响应、请求失败与真实 SDK 序列化测试。安装并核对 SDK 0.6.0 类型。
- [x] HTTP 与界面：完成会话、扫描、分类、移动、历史、撤销接口与中文响应式界面；HTTP 和浏览器完整移动/撤销验证通过。
- [x] 交付：14 项核心/HTTP 测试、2 项 Chrome 浏览器测试与语法检查通过；本地服务在 3210 端口启动。README 已记录启动方法、Key 配置、日志与限制。真实 TypeSafe 服务因未提供 API Key 尚未实测。
