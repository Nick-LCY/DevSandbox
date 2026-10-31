import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../../api/client';
import type { Template } from '../../api/types';
import { formatTimestamp } from '../../lib/format';
import { useToast } from '../Toast';
import { ModalShell } from './ModalShell';

/**
 * 启动模板管理区（设置抽屉的第二区）。
 *
 * 一份模板就是一份沙箱启动配置。模板只影响**之后新建沙箱**时的回填：
 * 已经建好的沙箱不再依赖模板，删除模板不会动到它们。
 *
 * 三件事：
 * - 列表：模板名 + 最近更新时间；
 * - 行内重命名：该行变成输入框，回车提交、Esc 取消，空名禁止提交；
 * - 删除：走确认弹窗，文案写明「只删模板，不影响已创建的沙箱」。
 */
export function TemplateManager() {
  const { show } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  /** 读取失败的原因（环境状态说明用 role=status，操作结果仍走 toast）。 */
  const [loadError, setLoadError] = useState('');
  /** 正在重命名的模板标识（null = 没有在重命名）。 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  /** 待删除的模板（null = 没有待删除的）。 */
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setTemplates(await api.listTemplates());
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : '读取模板列表失败';
      setLoadError(message);
      // 读取失败：弹失败 toast（抽屉里不再挂失败横幅）。
      show('error', message, { source: 'settings-template' });
    } finally {
      setLoading(false);
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 开始重命名：这一行变成输入框。 */
  const startRename = useCallback((template: Template) => {
    setRenamingId(template.id);
    setRenameDraft(template.name);
    setRenameError('');
  }, []);

  /** 取消重命名：回到只读的一行。 */
  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameDraft('');
    setRenameError('');
  }, []);

  /** 提交重命名：空名禁提交。 */
  const submitRename = useCallback(async () => {
    if (renamingId === null) {
      return;
    }
    const nextName = renameDraft.trim();
    if (nextName === '') {
      setRenameError('模板名称不能为空');
      return;
    }
    setRenaming(true);
    try {
      const updated = await api.renameTemplate(renamingId, nextName);
      setTemplates((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
      show('success', `模板 ${updated.name} 已重命名`, { source: 'settings-template' });
      cancelRename();
    } catch (exc) {
      show('error', exc instanceof Error ? exc.message : '重命名模板失败', {
        source: 'settings-template',
      });
    } finally {
      setRenaming(false);
    }
  }, [cancelRename, renameDraft, renamingId, show]);

  /** 确认删除：只删模板，已创建的沙箱不受影响。 */
  const confirmDelete = useCallback(async () => {
    if (deleteTarget === null) {
      return;
    }
    setDeleting(true);
    try {
      await api.deleteTemplate(deleteTarget.id);
      show('success', `模板 ${deleteTarget.name} 已删除`, { source: 'settings-template' });
      setDeleteTarget(null);
      await load();
    } catch (exc) {
      show('error', exc instanceof Error ? exc.message : '删除模板失败', {
        source: 'settings-template',
      });
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load, show]);

  return (
    <div data-testid="page-settings-template-section">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">启动模板</h3>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          data-testid="page-settings-template-refresh-button"
          className="inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2 text-[12.5px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        >
          {loading ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              正在刷新
            </>
          ) : (
            '刷新模板'
          )}
        </button>
      </div>

      <p className="mb-2 text-[12px] text-muted-foreground">
        模板是一份沙箱启动配置：新建沙箱时选中即回填。删除模板只影响模板本身，
        已经创建好的沙箱不受影响。
      </p>

      {loading && templates.length === 0 && (
        <p className="text-[12.5px] text-muted-foreground" data-testid="page-settings-template-loading">
          正在读取模板列表…
        </p>
      )}

      {loadError && (
        <p
          // 环境状态说明（不是操作结果），故走 role=status 而不是行内红字。
          role="status"
          className="text-[12px] text-muted-foreground"
          data-testid="page-settings-template-status"
        >
          模板列表读取失败，原因见右上角提示：{loadError}
        </p>
      )}

      {!loading && !loadError && templates.length === 0 && (
        <p className="text-[12.5px] text-muted-foreground" data-testid="page-settings-template-empty">
          还没有模板。在「新建沙箱」抽屉里填好表单后点「保存为模板」即可。
        </p>
      )}

      {templates.length > 0 && (
        <ul className="m-0 list-none space-y-1.5 p-0" data-testid="page-settings-template-list">
          {templates.map((template) => {
            const isRenaming = renamingId === template.id;
            return (
              <li
                key={template.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2.5 py-2"
                data-testid="page-settings-template-item"
                data-template-id={template.id}
                data-template-name={template.name}
              >
                {isRenaming ? (
                  <>
                    <input
                      className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 py-1 text-[13px] text-foreground transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      type="text"
                      value={renameDraft}
                      autoFocus
                      onChange={(event) => {
                        setRenameDraft(event.target.value);
                        setRenameError('');
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void submitRename();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelRename();
                        }
                      }}
                      data-testid="page-settings-template-rename-input"
                    />
                    <button
                      type="button"
                      onClick={() => void submitRename()}
                      // 空名禁提交：按钮直接禁用。
                      disabled={renaming || renameDraft.trim() === ''}
                      data-testid="page-settings-template-rename-save-button"
                      className="inline-flex h-7 items-center justify-center rounded-lg border border-transparent bg-primary px-2 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                    >
                      {renaming ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          正在保存
                        </>
                      ) : (
                        '保存'
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={cancelRename}
                      disabled={renaming}
                      data-testid="page-settings-template-rename-cancel-button"
                      className="inline-flex h-7 items-center justify-center rounded-lg border border-border bg-background px-2 text-[12.5px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <span
                      className="min-w-0 flex-1 truncate text-[13px] text-foreground"
                      data-testid="page-settings-template-name"
                    >
                      {template.name}
                    </span>
                    <span
                      className="text-[11.5px] text-muted-foreground"
                      data-testid="page-settings-template-updated-at"
                    >
                      更新于 {formatTimestamp(template.updated_at)}
                    </span>
                    <button
                      type="button"
                      onClick={() => startRename(template)}
                      data-testid="page-settings-template-rename-button"
                      className="inline-flex h-7 items-center justify-center gap-1 rounded-lg border border-border bg-card px-2 text-[12.5px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <Pencil className="size-3.5" aria-hidden="true" />
                      重命名
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(template)}
                      data-testid="page-settings-template-delete-button"
                      className="inline-flex h-7 items-center justify-center gap-1 rounded-lg border border-destructive/40 px-2 text-[12.5px] text-destructive transition-colors hover:bg-destructive-soft focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      删除
                    </button>
                  </>
                )}
                {isRenaming && renameError !== '' && (
                  <p
                    role="alert"
                    className="w-full text-[12px] text-destructive"
                    data-testid="page-settings-template-rename-error"
                  >
                    {renameError}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ModalShell
        open={deleteTarget !== null}
        title={`删除模板 ${deleteTarget?.name ?? ''}`}
        testId="page-settings-template-delete-dialog"
        onOpenChange={(next) => {
          if (!next) {
            setDeleteTarget(null);
          }
        }}
        closeDisabled={deleting}
        maxWidthPx={400}
        footer={
          <>
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
              data-testid="page-settings-template-delete-cancel-button"
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              disabled={deleting}
              data-testid="page-settings-template-delete-confirm-button"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-destructive px-3 text-[13px] font-medium text-white transition-colors hover:bg-destructive/90 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            >
              {deleting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  正在删除
                </>
              ) : (
                '确认删除'
              )}
            </button>
          </>
        }
      >
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          删除后这份启动配置就没了：以后新建沙箱不能再一键回填它。此操作不可撤销。
        </p>
        <div
          className="mt-3 flex items-start gap-2 rounded-lg border border-success/30 bg-success-soft px-3 py-2.5 text-[12.5px] text-success"
          data-testid="page-settings-template-delete-untouched-note"
        >
          <span>只删模板，不影响已创建的沙箱</span>
        </div>
      </ModalShell>
    </div>
  );
}
