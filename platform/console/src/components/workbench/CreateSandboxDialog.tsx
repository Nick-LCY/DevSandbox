import { useCallback, useEffect, useState } from 'react';

import { api } from '../../api/client';
import type { CreateSandboxResponse, HostImage } from '../../api/types';
import { parseEnvLines } from '../../lib/env';
import { formatBytes, formatTimestamp } from '../../lib/format';
import {
  formatMountDeclaration,
  parseMountDeclaration,
  validateMountDeclarations,
  type MountDeclaration,
} from '../../lib/mounts';
import { validateImageSelection, validateSandboxName } from '../../lib/validate';
import { ModalShell } from './ModalShell';

interface MountRow {
  id: string;
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

/** 挂载行自增编号。 */
let mountRowSeq = 0;

function newMountRow(): MountRow {
  mountRowSeq += 1;
  return { id: `mount-${mountRowSeq}`, hostPath: '', containerPath: '', readOnly: false };
}

interface CreateSandboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 创建成功后回调（工作台据此选中新建的沙箱）。 */
  onCreated: (name: string) => void;
}

const inputClass =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-[13px] ' +
  'text-foreground transition-colors outline-none placeholder:text-muted-foreground ' +
  'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ' +
  'disabled:pointer-events-none disabled:opacity-50';

const labelClass = 'mb-1.5 block text-[12.5px] font-medium text-foreground';

/**
 * 新建沙箱弹窗。
 *
 * 字段与校验整体搬自旧的「新建沙箱」页：镜像下拉（可刷新）、挂载行增删、
 * 启动命令、工作目录、环境变量。创建成功后原地切成功态，
 * 「打开沙箱详情」= 选中该沙箱 + 关弹窗。
 */
export function CreateSandboxDialog({ open, onOpenChange, onCreated }: CreateSandboxDialogProps) {
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [images, setImages] = useState<HostImage[]>([]);
  const [imagesError, setImagesError] = useState('');
  const [loadingImages, setLoadingImages] = useState(true);
  const [mounts, setMounts] = useState<MountRow[]>([]);
  const [command, setCommand] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateSandboxResponse | null>(null);

  const loadImages = useCallback(async () => {
    setLoadingImages(true);
    setImagesError('');
    try {
      const list = await api.listImages();
      setImages(list);
      setImage((current) => {
        if (current && list.some((item) => item.reference === current)) {
          return current;
        }
        const preferred = list.find((item) => item.reference.includes('sandbox-platform/sandbox-default'));
        return preferred?.reference ?? list[0]?.reference ?? '';
      });
    } catch (exc) {
      setImagesError(exc instanceof Error ? exc.message : '读取宿主本地镜像失败');
    } finally {
      setLoadingImages(false);
    }
  }, []);

  // 弹窗打开时拉一次镜像，并清掉上一轮的表单与成功态。
  useEffect(() => {
    if (!open) {
      return;
    }
    setName('');
    setMounts([]);
    setCommand('');
    setWorkdir('');
    setEnvText('');
    setError('');
    setResult(null);
    void loadImages();
  }, [open, loadImages]);

  // 页面重新可见时补拉一次镜像：镜像下拉要跟得上宿主上的真实变化。
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && open) {
        void loadImages();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [loadImages, open]);

  const updateMount = useCallback((id: string, patch: Partial<MountRow>) => {
    setMounts((previous) =>
      previous.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }, []);

  const submit = useCallback(async () => {
    setError('');
    setResult(null);

    const nameError = validateSandboxName(name);
    if (nameError) {
      setError(nameError);
      return;
    }
    const imageError = validateImageSelection(image);
    if (imageError) {
      setError(imageError);
      return;
    }

    const declarations: string[] = [];
    const parsedDeclarations: MountDeclaration[] = [];
    for (const row of mounts) {
      if (row.hostPath.trim() === '' && row.containerPath.trim() === '') {
        continue;
      }
      const parsed = parseMountDeclaration(
        `${row.hostPath.trim()}:${row.containerPath.trim()}${row.readOnly ? ':ro' : ''}`,
      );
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      parsedDeclarations.push(parsed.declaration);
      declarations.push(formatMountDeclaration(parsed.declaration));
    }

    // 容器路径重复在前端先拦一道：少一次往返，错误也更直白。
    const mountError = validateMountDeclarations(parsedDeclarations);
    if (mountError) {
      setError(mountError);
      return;
    }

    const envResult = parseEnvLines(envText);
    if (!envResult.ok) {
      setError(envResult.error);
      return;
    }

    setSubmitting(true);
    try {
      const created = await api.createSandbox({
        name: name.trim(),
        image,
        // 镜像来自宿主本地镜像列表：一律走宿主导出注入，不经镜像代理拉取
        image_source: 'host',
        mounts: declarations,
        command: command.trim() === '' ? null : command.trim(),
        workdir: workdir.trim() === '' ? null : workdir.trim(),
        env: envResult.env,
      });
      setResult(created);
      setName('');
      setMounts([]);
      setCommand('');
      setWorkdir('');
      setEnvText('');
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '创建沙箱失败');
    } finally {
      setSubmitting(false);
    }
  }, [name, image, mounts, command, workdir, envText]);

  const selectedImage = images.find((item) => item.reference === image) ?? null;

  const footer = result ? (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(false)}
        className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        关闭
      </button>
      <button
        type="button"
        onClick={() => {
          onCreated(result.metadata.name);
          onOpenChange(false);
        }}
        data-testid="page-sandbox-create-success-link"
        className="inline-flex h-8 items-center justify-center rounded-lg border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        打开沙箱详情
      </button>
    </>
  ) : (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(false)}
        disabled={submitting}
        className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      >
        取消
      </button>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={submitting}
        data-testid="page-sandbox-create-submit-button"
        className="inline-flex h-8 items-center justify-center rounded-lg border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      >
        {submitting ? '正在创建…' : '创建沙箱'}
      </button>
    </>
  );

  return (
    <ModalShell
      open={open}
      title="新建沙箱"
      testId="page-sandbox-create-dialog"
      onOpenChange={onOpenChange}
      maxWidthClassName="max-w-[640px]"
      footer={footer}
    >
      <h2 className="sr-only" data-testid="page-sandbox-create-title">
        新建沙箱
      </h2>

      {result && (
        <div
          className="mb-4 rounded-lg border border-success/30 bg-success-soft px-3 py-3"
          data-testid="page-sandbox-create-success"
        >
          <p className="text-[13px] text-success" data-testid="page-sandbox-create-success-message">
            沙箱 {result.metadata.name} 创建成功。
          </p>
          <ol
            className="mt-2 list-decimal space-y-0.5 pl-5 text-[12.5px] text-muted-foreground"
            data-testid="page-sandbox-create-steps"
          >
            {result.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="mt-2 font-mono text-[12px] break-all text-muted-foreground">
            {result.connection.exec_command}
          </p>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive-soft px-3 py-2 text-[12.5px] text-destructive"
          data-testid="page-sandbox-create-error-message"
        >
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className={labelClass} htmlFor="sandbox-name">
            沙箱名
          </label>
          <input
            id="sandbox-name"
            className={inputClass}
            type="text"
            value={name}
            placeholder="小写字母、数字、连字符与下划线，最长 24 位"
            onChange={(event) => setName(event.target.value)}
            data-testid="page-sandbox-create-name-input"
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="sandbox-image">
            启动镜像（宿主本地镜像）
          </label>
          <div className="flex items-center gap-2">
            <select
              id="sandbox-image"
              className={inputClass}
              value={image}
              onChange={(event) => setImage(event.target.value)}
              data-testid="page-sandbox-create-image-select"
            >
              <option value="">（请选择）</option>
              {images.map((item) => (
                <option key={item.reference} value={item.reference}>
                  {item.reference}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadImages()}
              disabled={loadingImages}
              data-testid="page-sandbox-create-image-refresh-button"
              className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            >
              {loadingImages ? '正在刷新…' : '刷新镜像'}
            </button>
          </div>
          {imagesError && (
            <p className="mt-1.5 text-[12px] text-destructive" data-testid="page-sandbox-create-image-error">
              {imagesError}
            </p>
          )}
          {!loadingImages && images.length === 0 && !imagesError && (
            <p className="mt-1.5 text-[12px] text-muted-foreground" data-testid="page-sandbox-create-image-empty">
              宿主上还没有本地镜像。请先在宿主构建或拉取镜像，再回来创建沙箱。
            </p>
          )}
          {selectedImage && (
            <p className="mt-1.5 text-[12px] text-muted-foreground" data-testid="page-sandbox-create-image-detail">
              {selectedImage.reference} · {formatBytes(selectedImage.size_bytes)} · 构建于{' '}
              {formatTimestamp(selectedImage.created_at)}
            </p>
          )}
          <p className="mt-1.5 text-[12px] text-muted-foreground">
            镜像来源固定为宿主本地（image_source=host）：平台从宿主导出注入，不经镜像代理拉取。
          </p>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className={labelClass}>挂载声明</span>
            <button
              type="button"
              onClick={() => setMounts((previous) => [...previous, newMountRow()])}
              data-testid="page-sandbox-create-mount-add-button"
              className="inline-flex h-7 items-center justify-center rounded-lg border border-border bg-card px-2 text-[12.5px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              添加挂载
            </button>
          </div>
          {mounts.length === 0 && (
            <p className="text-[12px] text-muted-foreground" data-testid="page-sandbox-create-mount-empty">
              暂未声明挂载。挂载格式为 宿主路径:容器路径[:ro]，平台不创建也不删除宿主目录。
            </p>
          )}
          <ul className="m-0 list-none space-y-2 p-0">
            {mounts.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-2"
                data-testid="page-sandbox-create-mount-item"
                data-mount-id={row.id}
              >
                <input
                  className={inputClass}
                  type="text"
                  placeholder="宿主路径，如 /data/project"
                  value={row.hostPath}
                  onChange={(event) => updateMount(row.id, { hostPath: event.target.value })}
                  data-testid="page-sandbox-create-mount-host-input"
                />
                <input
                  className={inputClass}
                  type="text"
                  placeholder="容器路径，如 /workspace"
                  value={row.containerPath}
                  onChange={(event) => updateMount(row.id, { containerPath: event.target.value })}
                  data-testid="page-sandbox-create-mount-container-input"
                />
                <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={row.readOnly}
                    onChange={(event) => updateMount(row.id, { readOnly: event.target.checked })}
                    data-testid="page-sandbox-create-mount-readonly-checkbox"
                    className="size-3.5 accent-primary"
                  />
                  只读
                </label>
                <button
                  type="button"
                  onClick={() => setMounts((previous) => previous.filter((item) => item.id !== row.id))}
                  data-testid="page-sandbox-create-mount-remove-button"
                  className="inline-flex h-7 items-center justify-center rounded-lg border border-destructive/40 px-2 text-[12.5px] text-destructive transition-colors hover:bg-destructive-soft focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <label className={labelClass} htmlFor="sandbox-command">
            容器启动命令（可选）
          </label>
          <input
            id="sandbox-command"
            className={inputClass}
            type="text"
            placeholder="留空则用镜像默认入口"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            data-testid="page-sandbox-create-command-input"
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="sandbox-workdir">
            容器工作目录（可选）
          </label>
          <input
            id="sandbox-workdir"
            className={inputClass}
            type="text"
            placeholder="如 /workspace"
            value={workdir}
            onChange={(event) => setWorkdir(event.target.value)}
            data-testid="page-sandbox-create-workdir-input"
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="sandbox-env">
            环境变量（可选，每行一条 键=值）
          </label>
          <textarea
            id="sandbox-env"
            className={`${inputClass} h-auto min-h-16 py-1.5`}
            rows={3}
            placeholder={'FOO=bar\nBAZ=qux'}
            value={envText}
            onChange={(event) => setEnvText(event.target.value)}
            data-testid="page-sandbox-create-env-input"
          />
        </div>
      </div>
    </ModalShell>
  );
}
