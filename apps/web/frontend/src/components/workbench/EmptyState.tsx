import { PanelTop, Plus } from 'lucide-react';

interface EmptyStateProps {
  /** 点「新建沙箱」打开新建弹窗。 */
  onCreateClick: () => void;
}

/**
 * 工作区空态：还没选中沙箱时的引导块。
 *
 * 右侧工作区没有内容时不留白：给一句说明 + 一个新建入口，
 * 让用户知道下一步该干什么。
 */
export function EmptyState({ onCreateClick }: EmptyStateProps) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-0 p-10"
      data-testid="page-sandbox-detail-empty"
    >
      <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-accent text-primary">
        <PanelTop className="size-6" aria-hidden="true" />
      </div>
      <h2 className="text-[16px] font-semibold">还没有选中沙箱</h2>
      <p className="mt-2 max-w-[380px] text-center text-[13px] leading-relaxed text-muted-foreground">
        在左侧选择一个沙箱查看它的终端会话；还没有沙箱的话，先从宿主本地镜像新建一个。
      </p>
      <button
        type="button"
        onClick={onCreateClick}
        data-testid="page-sandbox-list-create-button"
        className="mt-5 inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Plus className="size-4" aria-hidden="true" />
        新建沙箱
      </button>
    </div>
  );
}
