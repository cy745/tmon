# Contributing to tmon

感谢你考虑为 tmon 贡献代码！以下是我们推荐的协作流程。

## 开发环境

- Node.js >= 22.18（原生 TypeScript 运行，无构建步骤）
- 本机开发：Windows / Linux / macOS 均可；Linux/macOS 路径建议跑一遍 `tests/e2e-linux.sh`

```bash
npm ci
npm run typecheck                    # 根包类型检查
cd web && npm ci && npx tsc --noEmit # Web 端类型检查
```

## 协作流程（issue → 分支 → PR）

> AI Agent 协作注意：**修复类工作请勿在主工作区进行**——使用 git worktree + 独立 Agent 执行（详见 [AGENTS.md](AGENTS.md)），主工作区只做主线开发。

1. **发现问题或想加功能** → 先在 GitHub 创建 issue（用模板：Bug Report / Feature Request），描述清楚：
   - Bug：复现步骤、期望行为、实际行为、平台/版本
   - Feature：动机、使用场景、期望行为
2. **认领/分配 issue**：在 issue 中留言声明（`/assign` 或让维护者分配）
3. **新开分支**（命名规范，**在独立 worktree 中创建**）：
   - `fix/<issue号>-<简述>` —— 修复
   - `feat/<issue号>-<简述>` —— 新功能
   - `docs/<简述>` —— 文档
4. **开发与自测**：
   - 提交信息遵循 Conventional Commits：`feat:` / `fix:` / `docs:` / `style:` / `refactor:` / `test:` / `chore:`
   - 涉及核心逻辑的改动，附上测试（`tests/` 下的 e2e 脚本或 vitest 单元测试）
5. **开 PR**（使用 PR 模板）：
   - 关联 issue（`Closes #<issue号>`）
   - 描述改动内容与验证方式
   - CI 通过（GitHub Actions：Linux e2e + 类型检查）
6. **Review 与合并**：至少一位维护者 review；合并采用 squash；合并后清理 worktree。

## 测试

| 测试 | 命令 | 说明 |
|---|---|---|
| 类型检查 | `npm run typecheck` + `cd web && npx tsc --noEmit` | 必跑 |
| Linux e2e | `bash tests/e2e-linux.sh` | 覆盖 sh -c / forkpty / 信号 / 进度 / 交互输入 |
| 单元测试 | `npx vitest run` | sanitize / store / encoding 等纯逻辑 |
| 安全测试 | `npm run test:security` | 启动真实 server，模拟恶意 Origin/Host/CSRF 注入/跨域 WS（CSWSH）/web 角色伪造事件，验证本地服务安全边界（tests/security/，与单元测试分目录） |

## 代码规范

- TypeScript strict 模式；`erasableSyntaxOnly`（Node 原生 TS，禁止 enum/namespace）
- 导入路径带 `.ts` 扩展名（NodeNext）
- 无格式化器强制，但保持与现有代码风格一致

## 安全

发现安全相关漏洞请勿公开 issue，通过仓库的 SECURITY.md 联系维护者。
