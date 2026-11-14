# 品牌资产（brand assets）

产品 logo 之类的**本地**品牌资产放这里，**运行时零 CDN**：一律随构建产物发布
（`assetsInlineLimit: 0`，构建后是独立的 `assets/*.svg` 文件）。

| 资产 | 来源 | 用法 |
|---|---|---|
| `obsidian.svg` | <https://upload.wikimedia.org/wikipedia/commons/1/10/2023_Obsidian_logo.svg>（Wikimedia Commons，2023 Obsidian 官方 logo，512×512） | `TerminalTabs.tsx` 里用 `<img src={...}>` 引入（**不内联**） |

## 为什么不内联、为什么用 `img`

`obsidian.svg` 内含 8 个 `logo-*` **渐变 id**（`logo-top-left` / `logo-bottom-edge` 等）。
SVG 的 `id` 是**文档级**的：同一份 SVG 内联两份，第二份的 `url(#logo-*)` 会指到
第一份的渐变节点上（DOM 里 id 重复），既不合规范、也会让配色在极端情况下错位。
`<img>` 引外部 SVG 是独立文档，天然没有 id 冲突，也顺带拿到浏览器缓存。

其余图标仍统一 `lucide-react`：**本地品牌 SVG 不算第二套图标库**。
