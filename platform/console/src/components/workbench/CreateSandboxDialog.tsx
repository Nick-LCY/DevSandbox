import { ChevronDown, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../../api/client';
import type { HostImage } from '../../api/types';
import { parseEnvLines } from '../../lib/env';
import { formatBytes, formatTimestamp } from '../../lib/format';
import {
  formatMountDeclaration,
  parseMountDeclaration,
  validateMountDeclarations,
  type MountDeclaration,
} from '../../lib/mounts';
import { validateImageSelection, validateSandboxName } from '../../lib/validate';
import { useToast } from '../Toast';
import {
  Combobox,
  ComboboxEmpty,
  ComboboxIcon,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxPopup,
  ComboboxPortal,
  ComboboxPositioner,
  ComboboxTrigger,
} from '../ui/combobox';
import { DrawerShell } from './DrawerShell';

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
  /** 创建成功回调（工作台据此弹成功 toast 并刷新列表）。 */
  onCreated: (name: string) => void;
  /** 抽屉宽度（视口宽度的百分比）。 */
  widthVw: number;
  /** 宽度变化回调（工作台负责持久化）。 */
  onWidthChange: (vw: number) => void;
}

const inputClass =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-[13px] ' +
  'text-foreground transition-colors outline-none placeholder:text-muted-foreground ' +
  'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ' +
  'disabled:pointer-events-none disabled:opacity-50';

/**
 * 镜像选择器的输入框。
 *
 * 与抽屉表单的输入框同一口径，只差宽度：它在输入组里是弹性子项
 * （右侧要给下拉箭头让位），不能写死 w-full。
 */
const imageInputClass =
  'h-8 w-auto min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 py-1 text-[13px] ' +
  'text-foreground transition-colors outline-none placeholder:text-muted-foreground ' +
  'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ' +
  'disabled:pointer-events-none disabled:opacity-50';

const labelClass = 'mb-1.5 block text-[12.5px] font-medium text-foreground';

/**
 * 新建沙箱抽屉。
 *
 * 字段与校验整体搬自旧的「新建沙箱」页：镜像选择器（可搜索、可刷新）、
 * 挂载行增删、启动命令、工作目录、环境变量。创建成功后直接关抽屉，
 * 工作台弹成功 toast 并刷新列表（不再有成功面板，也不自动选中新建的沙箱）。
 */
export function CreateSandboxDialog({
  open,
  onOpenChange,
  onCreated,
  widthVw,
  onWidthChange,
}: CreateSandboxDialogProps) {
  const { show } = useToast();
  const [name, setName] = useState('');
  /** 当前选中的镜像引用（空串 = 没选）。 */
  const [image, setImage] = useState('');
  /** 镜像选择器的输入框文字（与选中分开管，原语才不会自行回填）。 */
  const [imageInput, setImageInput] = useState('');
  const [images, setImages] = useState<HostImage[]>([]);
  const [imagesError, setImagesError] = useState('');
  const [loadingImages, setLoadingImages] = useState(true);
  const [mounts, setMounts] = useState<MountRow[]>([]);
  const [command, setCommand] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [envText, setEnvText] = useState('');
  /** 本地表单校验的错误：留在抽屉里就地展示，不走 toast。 */
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadImages = useCallback(async () => {
    setLoadingImages(true);
    setImagesError('');
    try {
      const list = await api.listImages();
      setImages(list);
      // 不自动选中任何镜像：抽屉打开后输入框是空的，选中由用户显式决定。
      // （曾经自动选中默认镜像，原语随即把 label 回填进输入框：
      // 真实用户是在预填文字后面追加，打字永远命中不了。）
      // 刷新后已选的镜像可能已经不在宿主上了：清掉选择，输入框也跟着清。
      const stillThere = (reference: string): boolean =>
        list.some((item) => item.reference === reference);
      setImage((current) => (current !== '' && !stillThere(current) ? '' : current));
      setImageInput((current) => (current !== '' && !stillThere(current) ? '' : current));
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : '读取宿主本地镜像失败';
      setImagesError(message);
      // 镜像列表读取失败：弹失败 toast；抽屉里另留一行就地环境状态说明
      // （toast 5 秒就消失，只留 toast 会让空的选择器变得没有解释）。
      show('error', message, { source: 'sandbox-create' });
    } finally {
      setLoadingImages(false);
    }
  }, [show]);

  // 抽屉打开时拉一次镜像，并清掉上一轮的表单。
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
    // 镜像选择器归零：输入框空着，没有预填的默认镜像。
    setImage('');
    setImageInput('');
    void loadImages();
  }, [open, loadImages]);

  // 页面重新可见时补拉一次镜像：镜像选择器要跟得上宿主上的真实变化。
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

  /**
   * 当前选中的镜像（提交用的就是它）。
   *
   * 选中只认显式选择（点中候选 / 键盘选中）：输入框里敲出来的文字不算，
   * 否则筛选会被原语跳过（关键字与选中值完全相同时原语不筛，列表会混进
   * 别的镜像）。
   */
  const selectedImage = images.find((item) => item.reference === image) ?? null;

  const submit = useCallback(async () => {
    setError('');

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
      // 创建成功：关抽屉 → 通知工作台（弹成功 toast + 刷新列表）→ 清空表单。
      onOpenChange(false);
      onCreated(created.metadata.name);
      setName('');
      setMounts([]);
      setCommand('');
      setWorkdir('');
      setEnvText('');
    } catch (exc) {
      // 提交后端失败：弹失败 toast（抽屉里不再挂失败横幅）。
      show('error', exc instanceof Error ? exc.message : '创建沙箱失败', {
        source: 'sandbox-create',
      });
    } finally {
      setSubmitting(false);
    }
  }, [name, image, mounts, command, workdir, envText, show, onCreated, onOpenChange]);

  /**
   * 镜像按 reference 不区分大小写做子串匹配。
   *
   * 不用原语默认的筛选：默认那套走 Intl.Collator 且忽略标点，
   * 「0.20」会把「0.2.0」也算命中，命中与否不好预期。这里自己给一条
   * 朴素的子串规则（前端本地筛，不发请求）。
   */
  const matchImage = useCallback(
    (item: HostImage, query: string) =>
      item.reference.toLowerCase().includes(query.trim().toLowerCase()),
    [],
  );

  const footer = (
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
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      >
        {submitting ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            正在创建
          </>
        ) : (
          '创建沙箱'
        )}
      </button>
    </>
  );

  return (
    <DrawerShell
      open={open}
      title="新建沙箱"
      testId="page-sandbox-create-dialog"
      onOpenChange={onOpenChange}
      // 创建请求在途时不让关抽屉：请求已经发出，不能半途退出
      // （与删除 / 停止弹窗的口径一致）。
      closeDisabled={submitting}
      widthVw={widthVw}
      onWidthChange={onWidthChange}
      footer={footer}
    >
      <h2 className="sr-only" data-testid="page-sandbox-create-title">
        新建沙箱
      </h2>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive-soft px-3 py-2 text-[12.5px] text-destructive"
          data-testid="page-sandbox-create-validation-error"
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
            <Combobox
              items={images}
              value={selectedImage}
              // 输入框受控：原语不再自行回填，文字只由这里改。
              inputValue={imageInput}
              onValueChange={(item) => {
                // 显式选中：输入框回填镜像引用，提交用的也是它。
                const reference = item?.reference ?? '';
                setImage(reference);
                setImageInput(reference);
              }}
              onInputValueChange={(next) => {
                setImageInput(next);
                // 输入文字偏离当前选中的镜像 → 放弃选中：
                // 「输入框显示」与「实际提交」因此不会分叉。
                setImage((current) => (current !== '' && current !== next ? '' : current));
              }}
              itemToStringLabel={(item) => item.reference}
              isItemEqualToValue={(item, current) => item.reference === current.reference}
              filter={matchImage}
            >
              <ComboboxInputGroup className="min-w-0 flex-1">
                <ComboboxInput
                  id="sandbox-image"
                  className={imageInputClass}
                  placeholder="搜索镜像"
                  data-testid="page-sandbox-create-image-select"
                />
                <ComboboxTrigger
                  aria-label="展开镜像列表"
                  data-testid="page-sandbox-create-image-trigger"
                >
                  <ComboboxIcon>
                    <ChevronDown className="size-4" aria-hidden="true" />
                  </ComboboxIcon>
                </ComboboxTrigger>
              </ComboboxInputGroup>
              <ComboboxPortal>
                <ComboboxPositioner>
                  <ComboboxPopup data-testid="page-sandbox-create-image-popup">
                    <ComboboxEmpty data-testid="page-sandbox-create-image-no-match">
                      暂无匹配镜像
                    </ComboboxEmpty>
                    <ComboboxList>
                      {(item: HostImage) => (
                        <ComboboxItem
                          key={item.reference}
                          value={item}
                          data-image-reference={item.reference}
                          data-testid="page-sandbox-create-image-option"
                        >
                          {item.reference}
                          <ComboboxItemIndicator />
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxPopup>
                </ComboboxPositioner>
              </ComboboxPortal>
            </Combobox>
            <button
              type="button"
              onClick={() => void loadImages()}
              disabled={loadingImages}
              data-testid="page-sandbox-create-image-refresh-button"
              className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            >
              {loadingImages ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  正在刷新
                </>
              ) : (
                '刷新镜像'
              )}
            </button>
          </div>
          {!loadingImages && images.length === 0 && !imagesError && (
            <p className="mt-1.5 text-[12px] text-muted-foreground" data-testid="page-sandbox-create-image-empty">
              宿主上还没有本地镜像。请先在宿主构建或拉取镜像，再回来创建沙箱。
            </p>
          )}
          {imagesError && (
            <p
              // 环境状态说明（不是操作结果），故走 role=status 而不是行内红字。
              role="status"
              className="mt-1.5 text-[12px] text-muted-foreground"
              data-testid="page-sandbox-create-image-status"
            >
              镜像列表读取失败，原因见右上角提示：{imagesError}
            </p>
          )}
          {selectedImage && (
            <p className="mt-1.5 text-[12px] text-muted-foreground" data-testid="page-sandbox-create-image-detail">
              {selectedImage.reference} · {formatBytes(selectedImage.size_bytes)} · 构建于{' '}
              {formatTimestamp(selectedImage.created_at)}
            </p>
          )}
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
    </DrawerShell>
  );
}
