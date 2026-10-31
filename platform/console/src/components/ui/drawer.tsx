import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"
import { cn } from "@/lib/cn"

function Drawer({ ...props }: DrawerPrimitive.Root.Props) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
}

function DrawerBackdrop({ className, ...props }: DrawerPrimitive.Backdrop.Props) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-backdrop"
      className={cn(
        // 遮罩深浅跟控制台的设计令牌一致（40% 黑），不做背景模糊：
        // 抽屉内容本身是表单与详情，背景保持原样更利于辨认。
        //
        // 退场时长 150ms，必须与面板一致（DrawerShell.tsx 的 [--tw-duration:150ms]）：
        // Base UI 只等**面板**上的动画结束就卸载整棵树，遮罩若先播完，
        // 淡出结束后会闪回全屏（实测 t=82ms 透明度 0.07 → t=116ms 回 1.00）。
        // 遮罩再改短就会复现闪回，改长则退场比面板迟钝。
        "fixed inset-0 z-50 bg-black/40 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        // 退场停在末帧（透明度 0）：动画播完后不回弹，卸载前不会闪回全屏。
        "data-closed:[--tw-animation-fill-mode:forwards]",
        className
      )}
      {...props}
    />
  )
}

function DrawerViewport({ className, ...props }: DrawerPrimitive.Viewport.Props) {
  return (
    <DrawerPrimitive.Viewport
      data-slot="drawer-viewport"
      className={cn(className)}
      {...props}
    />
  )
}

function DrawerPopup({ className, ...props }: DrawerPrimitive.Popup.Props) {
  return (
    <DrawerPrimitive.Popup
      data-slot="drawer-popup"
      className={cn(className)}
      {...props}
    />
  )
}

function DrawerContent({ className, ...props }: DrawerPrimitive.Content.Props) {
  return (
    <DrawerPrimitive.Content
      data-slot="drawer-content"
      className={cn(className)}
      {...props}
    />
  )
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DrawerDescription({ className, ...props }: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

export {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerPopup,
  DrawerPortal,
  DrawerTitle,
  DrawerViewport,
}
