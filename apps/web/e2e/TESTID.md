# data-testid 定位规范

端到端用例**只允许**用 `data-testid` 定位元素。理由：样式与文案会变，测试标识不会；
用例不依赖样式与文案，就不会因为一次改版整批红。

本文件是约定，不是强制：示例项目与用户项目都要遵守，否则脚本化测试会频繁因选择器失效而中断。

---

## 一、命名规则

| 规则 | 说明 |
|---|---|
| 格式 | `page-<页面>-<元素>`，三段式 |
| 字符集 | **只允许小写字母、数字、连字符**（`a-z` `0-9` `-`） |
| 分隔 | 段与段之间用单个连字符 `-`，不用下划线、不用驼峰 |
| 长度 | 建议 ≤ 40 字符 |
| 语义 | 页面段写页面语义名（`home`、`login`、`order-list`），元素段写元素语义名（`title`、`submit-button`） |
| 稳定 | 改版时**沿用**原标识；只有元素语义真的变了才改标识，并同步改用例 |

### 三段怎么取

```
page - home - title
 │     │      └── 元素段：这个元素是什么（title）
 │     └───────── 页面段：元素属于哪个页面（home）
 └─────────────── 前缀：固定 page
```

- 页面段用**稳定**的页面名，不用 URL 片段（URL 会带参数、会重命名）。
- 元素段用**元素角色**，不用样式类名、不用文案原文（文案会改语言、会长短）。
- 同一个页面里同一个角色的元素重复出现时，在末尾加区分后缀：`page-order-list-item`、`page-order-list-item-price`。

---

## 二、示例（12 个）

| 标识 | 用在哪 |
|---|---|
| `page-home-title` | 首页标题 |
| `page-home-list` | 首页列表容器 |
| `page-home-list-item` | 首页列表里的条目 |
| `page-home-submit-button` | 首页表单的提交按钮 |
| `page-login-form` | 登录页表单 |
| `page-login-username-input` | 登录页的用户名输入框 |
| `page-login-password-input` | 登录页的密码输入框 |
| `page-login-error-message` | 登录失败的错误提示 |
| `page-order-list` | 订单列表页的列表容器 |
| `page-order-list-item-price` | 订单列表里的价格元素 |
| `page-order-detail-header` | 订单详情页的页头 |
| `page-settings-profile-form` | 设置页的个人资料表单 |

写法示例：

```html
<h1 data-testid="page-home-title">沙箱平台端到端样例页</h1>
<li data-testid="page-home-list-item">用例一：脚本模式</li>
<input data-testid="page-login-username-input" name="username" />
```

用例里只用这一种定位方式：

```ts
await expect(page.getByTestId('page-home-title')).toBeVisible();
await expect(page.getByTestId('page-home-list-item')).toHaveCount(3);
```

---

## 三、反例

| 反例 | 问题 |
|---|---|
| `page_home_title` | 用了下划线，不符合「只允许字母数字与连字符」 |
| `home-title` | 缺 `page-` 前缀，无法看出这是页面级标识 |
| `page-Home-Title` | 用了大写字母 |
| `page-home-title-1` | 序号式命名：元素顺序一变就失效，应该按语义区分 |
| `page-home .title` | 含空格与点号，点号是 CSS 特殊字符 |
| `page-home#title` | 含 `#`，井号是 CSS 特殊字符 |
| `page-home[title]` | 含方括号，是 CSS 属性选择器语法 |
| `page-home>title` | 含 `>`，是 CSS 子代选择器语法 |
| `page-home:title` | 含冒号，与伪类语法冲突 |
| `page-home-标题` | 含中文等非 ASCII 字符 |
| `page-home-title ` | 结尾有空格，查找时会匹配不到 |
| `btn-primary` | 缺页面段，换页面就撞名；且 `btn` 是样式语义不是元素语义 |
| `page-home-点击登录` | 用了文案原文，文案一改就失效 |

---

## 四、机器校验

契约断言脚本会扫描用例目录，发现下列写法即判不通过：

```bash
bash tools/assert-testid-only.sh
```

被禁的写法：XPath 定位、按文案/角色/标签等语义定位、`locator()` 传字符串、`page.$` / `page.$$`、DOM 原生选择器。

**唯一允许的定位入口是 `getByTestId()`。**
