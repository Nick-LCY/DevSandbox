import type { ReclaimPlan } from '../api/types';

/** 回收清单里固定出现的字样（后端 `untouched_note` 为空时的兜底）。 */
export const UNTOUCHED_NOTE_FALLBACK = '用户挂载的宿主机目录不受影响';

interface ReclaimDialogProps {
  plan: ReclaimPlan;
  /** 标识前缀，页面各自传入（`page-sandbox-list-delete` / `page-sandbox-detail-delete`）。 */
  testIdPrefix: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 删除确认弹窗。
 *
 * 删除前先把平台回收清单摆出来，并明确写出「用户挂载的宿主机目录不受影响」；
 * 用户确认后才发删除请求，取消则一个删除请求都不发。
 */
export function ReclaimDialog({
  plan,
  testIdPrefix,
  busy,
  onConfirm,
  onCancel,
}: ReclaimDialogProps) {
  const note = plan.untouched_note.trim() || UNTOUCHED_NOTE_FALLBACK;

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" data-testid={`${testIdPrefix}-dialog`}>
      <div className="dialog">
        <h2 className="dialog-title" data-testid={`${testIdPrefix}-title`}>
          删除沙箱 {plan.sandbox_name}
        </h2>
        <p className="dialog-note" data-testid={`${testIdPrefix}-untouched-note`}>
          {note}
        </p>
        <p className="dialog-hint">平台将回收以下资源：</p>
        <ul className="dialog-list" data-testid={`${testIdPrefix}-items`}>
          {plan.items.map((item) => (
            <li key={item} data-testid={`${testIdPrefix}-item`}>
              {item}
            </li>
          ))}
        </ul>
        {plan.user_mounts.length > 0 && (
          <>
            <p className="dialog-hint">用户声明的挂载（保持原样，不创建也不删除）：</p>
            <ul className="dialog-list" data-testid={`${testIdPrefix}-user-mounts`}>
              {plan.user_mounts.map((item) => (
                <li key={item} data-testid={`${testIdPrefix}-user-mount-item`}>
                  {item}
                </li>
              ))}
            </ul>
          </>
        )}
        {plan.incomplete && (
          <p className="dialog-warning" data-testid={`${testIdPrefix}-incomplete`}>
            依赖容器清单可能不完整（实时扫描未成功），删除后请人工核对残留容器。
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button button-danger"
            onClick={onConfirm}
            disabled={busy}
            data-testid={`${testIdPrefix}-confirm-button`}
          >
            {busy ? '正在删除…' : '确认删除'}
          </button>
          <button
            type="button"
            className="button"
            onClick={onCancel}
            disabled={busy}
            data-testid={`${testIdPrefix}-cancel-button`}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
