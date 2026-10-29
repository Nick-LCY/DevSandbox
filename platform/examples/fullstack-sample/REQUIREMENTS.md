# 当前已实现功能清单

> 这是本项目**当前**的能力基线。下一轮需求在 [BRIEF-NEXT.md](./BRIEF-NEXT.md)，
> 下一个执行者只需要那份需求 + 本文件（知道现状与边界），不需要读历史。

平台版本：沙箱平台一期 · 任务 06 第一步（闭环验收演练由后续执行）

---

## 一、身份认证（Logto OIDC 授权码 + PKCE）

| 能力 | 现状 | 证据 |
|---|---|---|
| 浏览器跳 Logto 登录页 | 前端点「用 Logto 登录」→ 后端下发授权地址 → 浏览器导航到 Logto 真实登录页 | `explore/02-logto-sign-in.png` |
| 真实输入用户名口令 | Playwright 在 Logto 登录页上填 `input[name=identifier]` / `input[name=password]` 并提交 | `tests/e2e/fullstack-sample.spec.ts` |
| 授权码回调 | Logto 302 回 `/auth/callback?code=...&state=...`，前端换 token | 同上 |
| id_token 校验 | 后端拉 Logto JWKS，校验签名、issuer、audience、有效期、nonce | `backend/app/auth.py` |
| 应用会话 | 校验通过后下发 HttpOnly 会话 Cookie；会话记住用户信息与本次使用的数据库 | `backend/app/auth.py` |
| 登出 | `POST /api/auth/logout` 销毁会话 | `backend/app/main.py` |
| 未登录保护 | 记录相关接口未登录返回 401 | 用例「未登录时记录接口拒绝访问」 |

**供应方式**：管理 API + 种子自带的机器对机器应用 `m-default`（`client_credentials` 换管理令牌）。
预置一个授权码应用（Traditional 类型，登记 `https://app:8000/auth/callback`）与一个测试用户
（`sampleuser` / `SamplePass123!`）。

---

## 二、业务数据（Postgres）

| 能力 | 现状 |
|---|---|
| 业务表 | `sample_records`（标题、内容、属主、附件对象键与元信息、创建时间） |
| 表结构 | `backend/migrations/001_sample_records.sql`；端到端基建里有一份同样的内容 |
| 写入 | `POST /api/records`（multipart：标题、内容、附件） |
| 读取 | `GET /api/records`（按创建时间倒序） |
| 每用例独立数据库 | 登录时用 `x-sample-database` 请求头选定库并记进会话，之后所有请求（含文件下载导航）都走同一个库 |
| 隔离佐证 | 用例直接查自己的用例库确认写入行；对照库里看不到对方的行 |

---

## 三、对象存储（MinIO，S3 协议）

| 能力 | 现状 |
|---|---|
| 上传 | 附件经 S3 `PutObject` 写入桶 `sample-records`，对象键 `records/<记录id>/<文件名>` |
| 下载 | `GET /api/records/{id}/file` 经 S3 `GetObject` 取回字节 |
| 桶管理 | `up.sh` 建桶；后端启动时兜底检查 |
| 真实往返 | 用例上传后下载回来逐字节比对一致（不依赖本地目录） |

---

## 四、前端（React + Vite）

| 页面/区块 | 现状 | data-testid |
|---|---|---|
| 首页标题 | 渲染 | `page-home-title` |
| 登录按钮 | 未登录时显示，点击跳 Logto | `page-home-login-button` |
| 用户信息 | 登录后显示姓名与邮箱 | `page-home-user-name`、`page-home-user-email` |
| 登出按钮 | 登录后显示 | `page-home-logout-button` |
| 新建记录表单 | 标题、内容、附件三个输入 | `page-home-record-form`、`page-home-record-title-input`、`page-home-record-content-input`、`page-home-record-file-input` |
| 提交按钮 | 提交中置灰并改文案 | `page-home-record-submit-button` |
| 提交结果 | 成功/失败提示 | `page-home-record-submit-status`、`page-home-record-error-message` |
| 记录列表 | 列表容器与条目 | `page-home-record-list`、`page-home-record-list-item` |
| 列表条目字段 | 标题、内容、属主 | `page-home-record-list-item-title`、`page-home-record-list-item-content`、`page-home-record-list-item-owner` |
| 附件下载 | 有附件的记录显示下载链接 | `page-home-record-list-item-file-link` |
| 空态 | 列表为空时的提示 | `page-home-record-list-empty` |
| 回调页 | 授权码换 token 的中间态与失败提示 | `page-auth-callback-title`、`page-auth-callback-status`、`page-auth-callback-error` |

静态外壳（`frontend/index.html`）里也放了 `page-home-title`，
这样健康门禁读原始 HTML 就能判应用是否就绪，不必等 JS 执行。

---

## 五、环境与工程

| 能力 | 现状 |
|---|---|
| 一条命令起全环境 | `scripts/up.sh`：12 步、每步有健康门禁、任一步失败即退出 |
| 停止 | `scripts/down.sh` |
| 不污染用户代码目录 | 源码复制到容器内 `/opt/sample` 再装依赖，用户目录只读 |
| 明文 + TLS 双协议 | 应用与 Logto 前置双协议代理，同端口两条路都通 |
| 依赖容器化 | postgres / minio / logto 全部容器化，按容器名互访 |
| 离线依赖包 | 三个依赖镜像都用平台离线包（`/opt/deps/images/`） |
| 环境变量清单 | `up.sh` 落 `app.env`；见 `backend/app/config.py` |

---

## 六、已知边界（下一轮要清楚的事）

1. **会话存在进程内存里**：应用重启后登录态丢失；多副本部署需要换成共享存储。
2. **示例项目不自带权限模型**：任何登录用户都能读写全部记录。
3. **记录列表一次全量返回**：没有分页，数据量大时要加。
4. **上传的附件不校验类型与大小**。
5. **业务表结构在两处各有一份**（示例项目与端到端基建），改动时要同步。
6. **端到端用例的第三方页面定位**集中在 `platform/e2e/helpers/logto-signin.ts`，
   契约断言脚本对它显式豁免并公示（Logto 登录页无法加 data-testid）。
