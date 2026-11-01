/**
 * 可搜索选择器（Base UI Combobox 原语封装）。
 *
 * 为什么用 Combobox 原语（而不是 Select / Autocomplete）：
 * - **Select 没有输入框**：候选一多只能滚动，选中前没法按关键字缩小范围；
 * - **Autocomplete 没有选中值语义**：输入框只是个带建议的文本框，
 *   「当前选中了哪一项」得另存一份状态，两份状态容易对不上；
 * - **Combobox 两者兼得**：输入框既能筛（前端本地筛，不发请求），
 *   又有明确的选中值语义（value / onValueChange）。
 *
 * 原语接管的行为（业务层不要自己重写）：
 * - 弹层开合（点输入框 / 上下键 / Esc / 点外部）与焦点归位；
 * - 键盘导航（上下键移动高亮、Enter 选中）与列表的 ARIA 语义
 *   （combobox / listbox / option）；
 * - 本地筛选：按 Root 的 items 与 filter 过滤，命中为空时才渲染 Empty；
 * - 选中项回填输入框（单选模式下输入框显示选中项的 label）。
 *
 * 通用性：封装不写死任何业务（不认「镜像」）。候选集（items）、
 * 取值文案（itemToStringLabel）、相等比较（isItemEqualToValue）、
 * 筛选策略（filter）全部通过 props 透传给原语。
 *
 * 样式口径：输入框与选项行跟抽屉表单一致（13px / h-8 / rounded-lg），
 * 不照搬 ui/select.tsx 的 text-sm。
 *
 * 两条与业务无关、但踩过坑的约定：
 *
 * - **输入框的回填由调用方接管**：原语在选中值变化时会把 label 写回输入框
 *   （未受控的 inputValue）。业务侧要把「输入框显示」当成唯一真相时，
 *   给 Root 传受控的 inputValue，原语就不再自行回填。
 * - **Empty 常驻但不能占位**：原语要求 Empty 的容器常驻（读屏软件靠它播报），
 *   容器自带内边距就会在弹层顶部留一块空白。内边距因此挪到内层元素上：
 *   列表非空时内层被原语摘掉，容器缩成零高。
 *
 * 展开箭头（`ComboboxIndicator`）的约定：
 *
 * - **箭头在输入框内部**：绝对定位贴在输入框右侧、垂直居中，不占布局宽度
 *   （输入框自己留出右侧内边距）。它是**纯指示器**：不可点击、对外隐藏，
 *   点击穿透到输入框，开合仍由输入框触发（原语默认点输入框即展开）。
 * - **朝向由原语的数据属性驱动**：输入组（InputGroup）在弹层展开时带
 *   `data-popup-open`，箭头按它旋转 180°，带过渡。
 */
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/cn';

/** 根组件的属性形状（单选模式，候选值与选中值同型）。 */
type ComboboxRootProps<Value> = ComboboxPrimitive.Root.Props<Value, false, Value>;

/**
 * 根组件：候选集与选中值的唯一来源。
 *
 * `items` 传给原语之后，命中项与空态都由原语按筛选结果算出来，
 * 业务层不必自己维护一份命中列表。
 */
function Combobox<Value,>({ ...props }: ComboboxRootProps<Value>) {
  return <ComboboxPrimitive.Root<Value, false, Value> {...props} />;
}

/** 输入框（既是搜索框也是选中值的显示位）。 */
function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-input"
      className={cn(
        // 与抽屉表单的输入框同一口径（13px / h-8 / rounded-lg / 焦点环）。
        // 宽度交给外层：输入框在输入组里是弹性子项，不写死 w-full。
        // 右侧内边距留给展开箭头（pr-8）：箭头压在输入框内部，文字不能走到它底下。
        'h-8 min-w-0 rounded-lg border border-input bg-transparent py-1 pl-2.5 pr-8 text-[13px] ' +
          'text-foreground transition-colors outline-none placeholder:text-muted-foreground ' +
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ' +
          'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

/** 输入框外层（把输入框与右侧控件合成一个整体，作为弹层的锚点）。 */
function ComboboxInputGroup({ className, ...props }: ComboboxPrimitive.InputGroup.Props) {
  return (
    <ComboboxPrimitive.InputGroup
      data-slot="combobox-input-group"
      // group 标记：展开箭头按输入组的 data-popup-open 转向。
      className={cn('group relative flex items-center', className)}
      {...props}
    />
  );
}

/**
 * 展开指示箭头（**纯指示器，不可点击**）。
 *
 * - 绝对定位在输入框内部右侧、垂直居中：不占布局宽度。
 * - `pointer-events-none`：点击穿透到输入框，开合由输入框触发（原语默认
 *   点输入框即展开，Esc / 点外部收起）。
 * - 装饰性：对辅助技术隐藏（原语给的 `aria-hidden`），也不进 Tab 序列。
 * - 朝向：弹层展开时输入组带 `data-popup-open`，箭头据此旋转 180°。
 *
 * 必须放在 `ComboboxInputGroup` 里面（转向靠输入组上的数据属性驱动）。
 */
function ComboboxIndicator({ className, children, ...props }: ComboboxPrimitive.Icon.Props) {
  return (
    <ComboboxPrimitive.Icon
      data-slot="combobox-indicator"
      className={cn(
        // 贴在输入框内部右侧、垂直居中；不可点击（点击落到输入框上）。
        'pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground',
        // 展开时转向：输入组（父级）带 data-popup-open 时生效。
        'transition-transform duration-150 group-data-[popup-open]:rotate-180',
        className,
      )}
      {...props}
    >
      {children ?? <ChevronDown className="size-4" aria-hidden="true" />}
    </ComboboxPrimitive.Icon>
  );
}

/** 弹层的传送门（挂到 body 上）。 */
function ComboboxPortal({ className, ...props }: ComboboxPrimitive.Portal.Props) {
  return (
    <ComboboxPrimitive.Portal
      data-slot="combobox-portal"
      // 弹层挂在 body 上，脱离了控制台外壳的 [data-console-shell] 作用域：
      // 补上标记，选中态与 color-scheme 规则照样命中。
      data-console-shell=""
      // 抽屉的横向滑动关闭是原语自带的、挡不住：弹层里的点选与拖选
      // 不能被它吃掉（整块弹层都在忽略名单里）。
      data-base-ui-swipe-ignore=""
      className={cn(className)}
      {...props}
    />
  );
}

/** 弹层的定位器（贴着锚点摆放）。 */
function ComboboxPositioner({
  className,
  side = 'bottom',
  sideOffset = 4,
  align = 'start',
  ...props
}: ComboboxPrimitive.Positioner.Props) {
  return (
    <ComboboxPrimitive.Positioner
      data-slot="combobox-positioner"
      side={side}
      sideOffset={sideOffset}
      align={align}
      className={cn('isolate z-50', className)}
      {...props}
    />
  );
}

/** 弹层面板（观感对齐 ui/select.tsx 的弹层）。 */
function ComboboxPopup({ className, ...props }: ComboboxPrimitive.Popup.Props) {
  return (
    <ComboboxPrimitive.Popup
      data-slot="combobox-popup"
      className={cn(
        // 高度上限跟着视口走（--available-height 由定位器给出）；
        // 内容超高时由内部列表滚动，弹层本身不滚（避免两根滚动条）。
        'relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-(--anchor-width) ' +
          'origin-(--transform-origin) overflow-hidden rounded-lg bg-popover ' +
          'text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 ' +
          'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 ' +
          'data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
        className,
      )}
      {...props}
    />
  );
}

/** 选项列表。 */
function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn(
        // 列表自己限高并内部滚动：288px 上限，同时不超过视口可用高度。
        // 空列表（data-empty）去掉内边距：否则列表底下一条空白带，
        // 弹层高度不贴合内容。
        'scroll-my-1 max-h-[min(18rem,var(--available-height,100vh))] overflow-y-auto p-1 ' +
          'outline-none data-[empty]:p-0',
        className,
      )}
      {...props}
    />
  );
}

/** 单个选项。 */
function ComboboxItem({ className, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        // 高亮态用 data-highlighted（Combobox 是虚拟焦点，选项本身不拿焦点）。
        // 指针光标逐项给：选项渲染成 role="option" 的 div，不是 button，
        // 全局兜底清单里的 [role=option] 会被这里的工具类盖掉，因此组件层
        // 直接写 cursor-pointer（工具类层级高于 base 层的兜底）。
        'relative flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 ' +
          'text-[13px] outline-hidden select-none data-highlighted:bg-accent ' +
          'data-highlighted:text-accent-foreground data-disabled:pointer-events-none ' +
          'data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}

/** 选中标记（对勾）。 */
function ComboboxItemIndicator({
  className,
  children,
  ...props
}: ComboboxPrimitive.ItemIndicator.Props) {
  return (
    <ComboboxPrimitive.ItemIndicator
      data-slot="combobox-item-indicator"
      className={cn(
        'pointer-events-none absolute right-2 flex size-4 items-center justify-center',
        className,
      )}
      {...props}
    >
      {children ?? <Check className="size-4" aria-hidden="true" />}
    </ComboboxPrimitive.ItemIndicator>
  );
}

/** 空态（筛选没命中时显示）。 */
function ComboboxEmpty({ className, children, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      // 外层不带内边距：原语要求这个容器常驻（读屏软件靠它播报），
      // 列表非空时它是个空盒子，带内边距就会在弹层顶部留一块空白。
      // 内边距挪到内层：列表非空时内层被原语摘掉，外层缩成零高。
      className={cn('text-[13px] text-muted-foreground', className)}
      {...props}
    >
      <span data-slot="combobox-empty-content" className="block px-2 py-3">
        {children}
      </span>
    </ComboboxPrimitive.Empty>
  );
}

export {
  Combobox,
  ComboboxEmpty,
  ComboboxIndicator,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxPopup,
  ComboboxPortal,
  ComboboxPositioner,
};
