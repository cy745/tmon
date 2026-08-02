# Agent 工作指引（AGENTS.md）

本文件为在 tmon 仓库中工作的 AI Agent（主 Agent 与子 Agent）提供工作约定。

## 核心原则

1. **主工作区保护**：主 Agent 的工作区只做主线开发（docs / feat）。**一切修复类工作必须在独立 git worktree 中进行**，由子 Agent 完成，通过 PR 合并回 main。
2. **零残留**：临时产物（测试文件、构建产物、容器）用完即清；优先使用一次性 Docker 容器（`--rm`）跑 Linux 验证，不污染本机环境。

## 修复工作流（issue → worktree → PR）

```bash
# 1. 在仓库根目录创建 worktree（不切换主工作区）
git worktree add ../tmon-fix-<n> -b fix/<issue号>-<简述>
cd ../tmon-fix-<n>

# 2. 修复 + 自测（类型检查、相关测试）
npm ci --silent
npm run typecheck
# Linux 验证（可选，容器零残留）：
docker run --rm -v "<绝对路径>:/src:ro" node:22 bash -c \
  "cp -r /src /tmp/tmon && cd /tmp/tmon && rm -rf node_modules web/node_modules && npm ci --silent && bash tests/e2e-linux.sh"

# 3. 提交（Conventional Commits：fix:/feat:/docs:/style:/test:/chore:）
git add -A && git commit -m "fix: <简述>（issue #N）"

# 4. 推送 + 开 PR（Closes #N）
git push -u origin fix/<issue号>-<简述>
gh pr create --title "..." --body "Closes #N ..."

# 5. 合并后清理 worktree
cd <仓库根> && git worktree remove ../tmon-fix-<n> --force
git branch -D fix/<issue号>-<简述> 2>/dev/null || true
```

## 环境

- Node >= 22.18（原生 TypeScript，无构建步骤）
- 本机：Windows（ConPTY）；Linux 验证用 Docker（node:22 镜像）
- 类型检查：`npm run typecheck` + `cd web && npx tsc --noEmit`
- Linux e2e：`bash tests/e2e-linux.sh`（容器内先 `npm ci`）

## 约定

- 提交信息：Conventional Commits（`feat:` / `fix:` / `docs:` / `style:` / `refactor:` / `test:` / `chore:`）
- 导入路径带 `.ts` 扩展名；TypeScript strict + `erasableSyntaxOnly`（禁 enum/namespace）
- 涉及核心逻辑的改动必须附带测试或 e2e 断言
- 长时间运行的命令用后台执行，避免阻塞
