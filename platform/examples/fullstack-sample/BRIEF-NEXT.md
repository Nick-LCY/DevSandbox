# 下一轮需求（BRIEF-NEXT）

> **下一个执行者只拿这份需求**：在**全新沙箱**里把它实现到端到端全绿。
> 本文件已经包含需要的全部上下文：现状（见 `REQUIREMENTS.md`）、边界、判据、命名。
> 不需要读历史提交、不需要读设计文档。

预计工作量：半天以内。两个小需求，互不依赖，可分两次提交。

---

## 零、怎么开工（照抄即可）

```bash
# ① 宿主：建沙箱，把示例项目与端到端基建挂进去
cd platform
uv run python cli/sandboxctl.py create brief-lab \
  --image sandbox-platform/sandbox-default:0.1.0 \
  --mount "$PWD/examples/fullstack-sample:/workspace/fullstack-sample" \
  --mount "$PWD/e2e:/workspace/e2e"

# ② 沙箱容器内：起全环境（12 步，每步带健康门禁）
bash /workspace/fullstack-sample/scripts/up.sh

# ③ 沙箱容器内：改码 → 重跑 up.sh → 跑端到端
#    改的是挂载目录里的源码；up.sh 会把它复制到容器内 /opt/sample 再装依赖、构建、启动
bash /workspace/fullstack-sample/scripts/up.sh
cd /workspace/e2e && pnpm run test:scripted     # 退出码 0 才算通过
```

改码后**必须重跑 `up.sh`**（应用进程与构建产物都在容器内，不会自动热更新）。

---

## 一、需求 R1：记录列表按关键字过滤

### 现状

列表页一次性展示 `GET /api/records` 返回的全量记录，没有过滤入口。

### 要做什么

在记录列表上方加一个关键字过滤区：

| 元素 | data-testid | 行为 |
|---|---|---|
| 关键字输入框 | `page-home-record-filter-input` | 单行文本输入 |
| 过滤按钮 | `page-home-record-filter-button` | 点击后按关键字过滤下方列表 |
| 清除按钮 | `page-home-record-filter-clear-button` | 点击后清空关键字并恢复全量列表 |

过滤规则（必须严格按这个来，判死活用例按它断言）：

1. 只看**标题**与**内容**两个字段，**不区分大小写**的子串匹配；
2. 关键字为空（空串或只有空格）时，过滤结果等于全量列表；
3. 过滤只影响**列表展示**，不改后端接口：`GET /api/records` 仍返回全量，过滤在浏览器端完成；
4. 过滤状态在列表重新加载（新建记录后刷新列表）后**保持**（关键字不清空）；
5. 清除按钮等价于「把关键字置空后再点过滤」。

### 判死活用例（追加到 `platform/e2e/tests/e2e/fullstack-sample.spec.ts`）

新用例名叫 `列表页按关键字过滤`：

1. 登录（复用 `helpers/logto-signin.ts` 的 `signInWithLogto`，别自己写第三份登录逻辑）；
2. 新建一条标题含独特关键字的记录（例如标题里放 `过滤靶标`），再建一条标题不含它的记录；
3. 在 `page-home-record-filter-input` 填入该关键字，点 `page-home-record-filter-button`；
4. 断言：`page-home-record-list-item` 的条数等于 1，且 `page-home-record-list-item-title` 的文本包含该关键字；
5. 点 `page-home-record-filter-clear-button`；
6. 断言：`page-home-record-list-item` 的条数恢复为 3（本用例库的 2 条种子记录 + 本用例新建的 2 条 = 4 条，注意按实际条数断言）。

> 注意：本用例独占一个数据库（种子 v2 有 2 条记录），新建 2 条后全量应为 4 条。
> 断言用相对判断（例如「过滤后条数少于过滤前」）比写死数字更稳，两者都可以。

---

## 二、需求 R2：提交过程的加载态

### 现状

提交按钮在请求进行中会置灰并把文案改成「保存中…」，
但页面上**没有一个可被端到端稳定判定的加载态元素**。

### 要做什么

1. 提交（含附件上传）进行期间，页面上出现一个**可见**的加载指示元素，`data-testid="page-home-record-upload-loading"`；
2. 提交结束后，该元素从页面上消失（不可见）；
3. 提交进行期间，`page-home-record-submit-button` 保持 disabled；
4. 该加载元素**最短显示 300 毫秒**：请求很快返回时也不立刻消失。
   理由：避免界面闪烁，同时让端到端用例能稳定地观察到加载态（这是硬性要求，不是建议）。

文案由你定（例如「上传中…」），但不要把关键信息只放在文案里 —— 判据只看元素是否可见。

### 判死活用例（新用例名叫 `提交过程有加载态`）

1. 登录；
2. 选一个附件文件，在标题与内容里填好值；
3. 点 `page-home-record-submit-button`；
4. 断言：`page-home-record-upload-loading` 可见（用 `expect(...).toBeVisible()`，它自带重试）；
5. 断言：提交完成后 `page-home-record-upload-loading` 不可见（`toBeHidden()` 或 `toHaveCount(0)`）；
6. 断言：列表里出现了刚才那条记录。

> 加载态最短 300 毫秒这条要求，就是为了让第 4 步的断言不 flaky —— 不要省掉它。

---

## 三、硬约束（不许破）

1. **元素定位只认 `data-testid`**：新加的用例与辅助代码里禁止 XPath、CSS 选择器、`getByText` 等，
   契约断言脚本 `platform/e2e/tools/assert-testid-only.sh` 会扫描并判不通过。
2. **命名按 `platform/e2e/TESTID.md`**：三段式 `page-<页面>-<元素>`，只允许小写字母、数字、连字符。
   本轮新增的标识都在「首页」这个页面上，页面段用 `home`。
3. **不许新增依赖容器**：Postgres / MinIO / Logto 三个依赖保持现状，不许用本地目录替代 MinIO，
   不许把 Logto 换成桩服务。
4. **不许改端到端门禁与依赖清单**：`platform/e2e/config/dependencies.json` 与
   `global-setup.ts` 的门禁顺序保持不变。
5. **现有 4 条用例必须继续全绿**（`pnpm run test:scripted` 退出码 0，用例数只会增加不会减少）。
6. **不许破坏挂载目录的干净性**：不要把 `.venv`、`node_modules`、`dist` 写进
   `platform/examples/fullstack-sample/`（`up.sh` 已经把它们放在容器内的 `/opt/sample`）。
7. 后端改动如果涉及业务表结构，**两处都要改**：
   `platform/examples/fullstack-sample/backend/migrations/` 与 `platform/e2e/migrations/`。

---

## 四、交什么

1. 代码改动（前端为主；后端只在必要时动）；
2. 新增的端到端用例（放在 `platform/e2e/tests/e2e/fullstack-sample.spec.ts` 或同目录新文件）；
3. `pnpm run test:scripted` 退出码 0 的运行输出；
4. `platform/e2e/artifacts/screenshots/` 下新增的截图；
5. 一份简短的说明：改了什么、判据怎么判的、实测耗时。
