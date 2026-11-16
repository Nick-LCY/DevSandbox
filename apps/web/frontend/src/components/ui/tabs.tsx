import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cn } from "@/lib/cn"

/**
 * Tabs 原语封装（Base UI `@base-ui/react/tabs`，零新增依赖）。
 *
 * 视觉语言跟工作台既有的终端标签条一致：**下划线式 tab**——容器一条分隔线，
 * 激活的 tab 用主色下划线（`border-primary`）+ 加重字色；未激活的 tab 只有
 * 悬停底色。全部走令牌工具类，**不写裸色值**。
 *
 * 激活态由 Base UI 自己挂在 tab 上的 `data-active` 表达（原语把 `active`
 * 状态映射成 `data-active` 属性），调用方不用自己维护选中态。
 */

function Tabs({ ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "flex shrink-0 items-end gap-1 border-b border-border mb-4",
        className
      )}
      {...props}
    />
  )
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "inline-flex h-9 shrink-0 items-center border-b-2 border-transparent px-3 text-[13px]",
        "text-muted-foreground transition-colors",
        "hover:bg-muted hover:text-foreground",
        "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        "data-active:border-primary data-active:font-medium data-active:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn("min-h-0 outline-none", className)}
      {...props}
    />
  )
}

export {
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
}
