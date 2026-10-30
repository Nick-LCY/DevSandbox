import { useCallback, useEffect, useState } from 'react';

import { api } from '../api/client';
import type { CreateSandboxResponse, HostImage } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { parseEnvLines } from '../lib/env';
import { formatBytes, formatTimestamp } from '../lib/format';
import {
  formatMountDeclaration,
  parseMountDeclaration,
  validateMountDeclarations,
  type MountDeclaration,
} from '../lib/mounts';
import { sandboxDetailHash } from '../lib/router';
import { validateImageSelection, validateSandboxName } from '../lib/validate';

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

/** 新建沙箱页：镜像下拉 + 挂载声明 + 提交。 */
export function SandboxCreatePage() {
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

  useEffect(() => {
    void loadImages();
  }, [loadImages]);

  // 页面重新可见时补拉一次镜像：镜像下拉要跟得上宿主上的真实变化。
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadImages();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [loadImages]);

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

  return (
    <section className="page">
      <div className="page-header">
        <h2 className="page-title" data-testid="page-sandbox-create-title">
          新建沙箱
        </h2>
        <a className="button" href="#/" data-testid="page-sandbox-create-back-button">
          返回列表
        </a>
      </div>

      <ErrorBanner message={error} testId="page-sandbox-create-error-message" />

      {result && (
        <div className="panel panel-success" data-testid="page-sandbox-create-success">
          <p data-testid="page-sandbox-create-success-message">
            沙箱 {result.metadata.name} 创建成功。
          </p>
          <ol className="steps" data-testid="page-sandbox-create-steps">
            {result.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="hint">{result.connection.exec_command}</p>
          <a
            className="button button-primary"
            href={sandboxDetailHash(result.metadata.name)}
            data-testid="page-sandbox-create-success-link"
          >
            打开沙箱详情
          </a>
        </div>
      )}

      <div className="panel">
        <div className="field">
          <label className="field-label" htmlFor="sandbox-name">
            沙箱名
          </label>
          <input
            id="sandbox-name"
            className="input"
            type="text"
            value={name}
            placeholder="小写字母、数字、连字符与下划线，最长 24 位"
            onChange={(event) => setName(event.target.value)}
            data-testid="page-sandbox-create-name-input"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="sandbox-image">
            启动镜像（宿主本地镜像）
          </label>
          <div className="field-row">
            <select
              id="sandbox-image"
              className="input"
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
              className="button"
              onClick={() => void loadImages()}
              disabled={loadingImages}
              data-testid="page-sandbox-create-image-refresh-button"
            >
              {loadingImages ? '正在刷新…' : '刷新镜像'}
            </button>
          </div>
          {imagesError && (
            <p className="hint hint-error" data-testid="page-sandbox-create-image-error">
              {imagesError}
            </p>
          )}
          {!loadingImages && images.length === 0 && !imagesError && (
            <p className="hint" data-testid="page-sandbox-create-image-empty">
              宿主上还没有本地镜像。请先在宿主构建或拉取镜像，再回来创建沙箱。
            </p>
          )}
          {selectedImage && (
            <p className="hint" data-testid="page-sandbox-create-image-detail">
              {selectedImage.reference} · {formatBytes(selectedImage.size_bytes)} · 构建于{' '}
              {formatTimestamp(selectedImage.created_at)}
            </p>
          )}
          <p className="hint">镜像来源固定为宿主本地（image_source=host）：平台从宿主导出注入，不经镜像代理拉取。</p>
        </div>

        <div className="field">
          <div className="field-label-row">
            <span className="field-label">挂载声明</span>
            <button
              type="button"
              className="button button-small"
              onClick={() => setMounts((previous) => [...previous, newMountRow()])}
              data-testid="page-sandbox-create-mount-add-button"
            >
              添加挂载
            </button>
          </div>
          {mounts.length === 0 && (
            <p className="hint" data-testid="page-sandbox-create-mount-empty">
              暂未声明挂载。挂载格式为 宿主路径:容器路径[:ro]，平台不创建也不删除宿主目录。
            </p>
          )}
          <ul className="mount-list">
            {mounts.map((row) => (
              <li
                key={row.id}
                className="mount-row"
                data-testid="page-sandbox-create-mount-item"
                data-mount-id={row.id}
              >
                <input
                  className="input"
                  type="text"
                  placeholder="宿主路径，如 /data/project"
                  value={row.hostPath}
                  onChange={(event) => updateMount(row.id, { hostPath: event.target.value })}
                  data-testid="page-sandbox-create-mount-host-input"
                />
                <input
                  className="input"
                  type="text"
                  placeholder="容器路径，如 /workspace"
                  value={row.containerPath}
                  onChange={(event) => updateMount(row.id, { containerPath: event.target.value })}
                  data-testid="page-sandbox-create-mount-container-input"
                />
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={row.readOnly}
                    onChange={(event) => updateMount(row.id, { readOnly: event.target.checked })}
                    data-testid="page-sandbox-create-mount-readonly-checkbox"
                  />
                  只读
                </label>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() =>
                    setMounts((previous) => previous.filter((item) => item.id !== row.id))
                  }
                  data-testid="page-sandbox-create-mount-remove-button"
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="sandbox-command">
            容器启动命令（可选）
          </label>
          <input
            id="sandbox-command"
            className="input"
            type="text"
            placeholder="留空则用镜像默认入口"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            data-testid="page-sandbox-create-command-input"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="sandbox-workdir">
            容器工作目录（可选）
          </label>
          <input
            id="sandbox-workdir"
            className="input"
            type="text"
            placeholder="如 /workspace"
            value={workdir}
            onChange={(event) => setWorkdir(event.target.value)}
            data-testid="page-sandbox-create-workdir-input"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="sandbox-env">
            环境变量（可选，每行一条 键=值）
          </label>
          <textarea
            id="sandbox-env"
            className="input textarea"
            rows={3}
            placeholder={'FOO=bar\nBAZ=qux'}
            value={envText}
            onChange={(event) => setEnvText(event.target.value)}
            data-testid="page-sandbox-create-env-input"
          />
        </div>

        <div className="form-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => void submit()}
            disabled={submitting}
            data-testid="page-sandbox-create-submit-button"
          >
            {submitting ? '正在创建…' : '创建沙箱'}
          </button>
        </div>
      </div>
    </section>
  );
}
