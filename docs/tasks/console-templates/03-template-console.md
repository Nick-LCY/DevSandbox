---
prd: prds/console-templates.md
status: todo
---
# 任务：模板前端与字体

## 目标
把「启动模板」做成网页控制台里可用的能力：新建沙箱抽屉加「加载模板 / 保存为模板」两个动作，侧边栏「代理设置」改名「设置」并在同一抽屉里加模板管理区（重命名、删除）；模板应用语义为「出现字段整体替换、缺失字段保持现状」，支持 `{name}` 占位符；字体字符源并入常用汉字表后重生成子集。

## 完成标准
- [ ] 新建 `platform/console/src/lib/templates.ts`，包含三个纯函数并有单元测试。
  - `applyTemplateConfig`：按「字段是否出现」做合并——出现的字段整体替换（挂载是整组替换，不是逐条合并），缺失的字段保持现状；用 `hasOwnProperty` 判出现与否。
  - `substituteNamePlaceholder`：把配置里的 `{name}` 替换为沙箱名；沙箱名为空时保留占位符原样。
  - `collectTemplateConfig`：从新建沙箱表单收集模板配置，空值字段不进配置对象。
- [ ] 模板配置的挂载解析采用宽松口径：允许以 `~` 开头的宿主路径。
- [ ] `platform/console/src/lib/mounts.ts` 的宿主路径校验放行 `~/` 前缀，单测同步补齐。
- [ ] `platform/console/src/api/types.ts` 与 `client.ts` 增加四条模板调用（列表、创建、重命名、删除）。
- [ ] 新建沙箱抽屉加「加载模板」：复用 `src/components/ui/combobox.tsx` 的可搜索下拉，本地筛选候选，**选中即回填**表单。
- [ ] 新建沙箱抽屉加「保存为模板」：走 `ModalShell` 命名弹窗，空名禁止提交，成功后弹成功 toast（来源 `sandbox-template`）。
- [ ] 新建沙箱抽屉的网络字段不在表单里展示，但随配置透传保存。
- [ ] `ProxySettingsDialog.tsx` 用 `git mv` 改名为 `SettingsDialog.tsx`，组件名与标题改为「设置」；既有 `page-settings-*` 标识全部不动。
- [ ] 设置抽屉第一区仍是代理设置，内容原样保留；第二区新增模板管理区。
- [ ] 模板管理区提供模板列表、行内重命名（回车提交、Esc 取消、空名禁止提交）与删除（走确认弹窗，文案写明删除模板不影响已建沙箱）。
- [ ] 侧边栏的「代理设置」项文案改为「设置」，图标换成 lucide `Settings`。
- [ ] 侧边栏该按钮的标识由 `page-layout-proxy-button` 改为 `page-layout-settings-button`；旧标识进 `platform/console/README.md` 的已退役清单；`platform/console/tests/specs/01-lifecycle.spec.ts` 里的一处引用同步改。
- [ ] 字体脚本的字符源并入常用汉字表：新建 `platform/console/scripts/fonts/common-hanzi.txt` 并入库（通用规范汉字表一级字，约 3500 字）；`build-fonts.sh` 在该文件缺失时报错退出，不静默跳过。
- [ ] 按新字符源重生成字体子集并入库 `platform/console/public/fonts/`。
- [ ] vitest 覆盖合并语义、占位符替换与交互；Playwright 新增 `platform/console/tests/specs/07-templates.spec.ts`，覆盖「保存 → 加载回填（含占位符）→ 重命名 → 删除 → 刷新不复活」全流程；`tests/helpers` 同步扩展。
- [ ] `pnpm typecheck`、`pnpm typecheck:tests`、`pnpm vitest`、`pnpm build` 全绿。
- [ ] Playwright 真机用例全绿（新旧用例一起跑）。
- [ ] 零新增依赖：模板能力不引入任何新包。
- [ ] 操作结果反馈一律走右上角 toast，不新增内嵌结果横幅。

## 依赖
- 依赖 [[tasks/console-templates/02-template-server.md|02 模板服务端]]：四条模板接口的契约先定，前端再对接。
- 交互底座沿用 [[conventions/console-frontend.md|网页控制台前端约定]]：可搜索选择器统一走 Combobox 原语封装、反馈统一走 toast、抽屉与确认类弹窗各一套实现。
- 需求来源见 [[prds/console-templates.md|控制台模板轮 PRD]] 的工作包三。

## 实施要点

### 合并语义
- 「出现字段整体替换、缺失字段保持现状」是本期模板应用的核心口径：用户填了挂载就整组替换（不是把新挂载并进旧挂载），没填挂载就保留表单里原有的挂载。
- 判断「字段是否出现」用 `hasOwnProperty`，不能用「值是否为空」——空值与缺失在语义上必须区分开，这一层在服务端落盘时同样用 `exclude_unset=True` 保住。

### 占位符
- `{name}` 出现在模板配置的任意字符串位置（挂载路径、环境变量值、命令、工作目录均可），加载模板时统一替换为当前沙箱名。
- 沙箱名为空时保留 `{name}` 原样，不替换成空串——否则会把配置改写成不可用的形态。

### 前端交互
- 「加载模板」复用已有的 Combobox 原语封装，不手搓下拉；候选来自列表接口，本地筛选，**选中即回填**（不额外加「应用」按钮）。
- 「保存为模板」走 `ModalShell` 命名弹窗，空名禁止提交；成功后弹成功 toast，来源标识 `sandbox-template`，便于验收脚本精确定位。
- 设置抽屉改名时用 `git mv` 保留文件历史；`page-settings-*` 标识全不动，只改侧边栏那一处 `page-layout-proxy-button`。
- 删除模板走确认弹窗，文案要写清「删除模板不影响已建沙箱」——沙箱一旦创建就不再依赖模板。

### 字体
- `build-fonts.sh` 的字符源由「从源码抽取 + 常用汉字表」两部分组成；常用汉字表文件缺失时脚本报错退出，不允许静默跳过（静默跳过会产出缺字形子集，表现为界面上的方框）。
- 新增中文文案后必须重跑脚本并把产物入库。

## 留档指引
- 标识表、已退役标识与工程口径：`platform/console/README.md`。
- 验收 helper 与用例覆盖：`platform/console/tests/README.md`。
- 交互与字体约定：[[conventions/console-frontend.md|网页控制台前端约定]]。
- 字体子集重生成脚本：`platform/console/scripts/build-fonts.sh`。
