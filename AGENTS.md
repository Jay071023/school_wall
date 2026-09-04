# Agent 工作入口

开始任何修改前，先阅读 [`docs/PROJECT_INDEX.md`](docs/PROJECT_INDEX.md)，按代码地图定位入口，避免扫描整个仓库。

必须遵守：

1. 修改 `frontend/` 后同步 `public/`，并运行 `npm run check:mirrors`。
2. `769px+` 走桌面布局，`768px-` 才走移动布局。
3. 修改后运行相关测试和 `git diff --check`，保留用户已有改动。
4. 部署前推送 Gitee `main`，部署后核对服务器提交号、`wall` 状态和健康检查。
5. 新增重要入口时同步更新 `docs/PROJECT_INDEX.md`。
