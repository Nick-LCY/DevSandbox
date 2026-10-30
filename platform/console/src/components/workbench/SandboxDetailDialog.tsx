import type { SandboxDetail } from '../../api/types';
import { formatBoolean, formatTimestamp, orPlaceholder } from '../../lib/format';
import { ModalShell } from './ModalShell';

interface SandboxDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: SandboxDetail | null;
  loading: boolean;
  error: string;
}

/** 详情里的一行：左标签右值。 */
function Field({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-[13px] break-all" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

/**
 * 沙箱详情弹窗。
 *
 * 完整字段一览：状态、镜像、镜像来源、系统用户、容器名、网桥网络、时间、
 * 套接字路径、容器内挂载点、工作目录、启动命令、子 ID 段、网络归属、
 * 环境变量（只显示键名）、挂载、依赖容器。
 *
 * 标识口径：与工作区头部重名的四个字段（状态 / 镜像 / 创建时间 / 更新时间）
 * 在弹窗里用 `page-sandbox-detail-dialog-*`，头部保持 `page-sandbox-detail-*`。
 * 弹窗开着时两个标识同时挂在页面上，同名会让 Playwright 严格模式直接报错。
 */
export function SandboxDetailDialog({
  open,
  onOpenChange,
  detail,
  loading,
  error,
}: SandboxDetailDialogProps) {
  return (
    <ModalShell
      open={open}
      title="沙箱详情"
      testId="page-sandbox-detail-dialog"
      onOpenChange={onOpenChange}
      maxWidthClassName="max-w-[720px]"
      footer={
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          关闭
        </button>
      }
    >
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive-soft px-3 py-2 text-[12.5px] text-destructive"
          data-testid="page-sandbox-detail-dialog-error"
        >
          {error}
        </div>
      )}

      {loading && !detail && (
        <p className="text-[12.5px] text-muted-foreground" data-testid="page-sandbox-detail-loading">
          正在读取沙箱详情…
        </p>
      )}

      {detail && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3.5">
            <Field label="状态" value={detail.state_label} testId="page-sandbox-detail-dialog-state" />
            <Field label="镜像" value={detail.image} testId="page-sandbox-detail-dialog-image" />
            <Field label="镜像来源" value={detail.image_source} testId="page-sandbox-detail-image-source" />
            <Field label="系统用户" value={detail.system_user} testId="page-sandbox-detail-system-user" />
            <Field label="容器名" value={detail.container_name} testId="page-sandbox-detail-container-name" />
            <Field
              label="网桥网络"
              value={`${detail.network_name}${
                detail.network_owned ? '（平台自建，删除时回收）' : '（用户指定，不回收）'
              }`}
              testId="page-sandbox-detail-network-name"
            />
            <Field
              label="创建时间"
              value={formatTimestamp(detail.created_at)}
              testId="page-sandbox-detail-dialog-created-at"
            />
            <Field
              label="更新时间"
              value={formatTimestamp(detail.updated_at)}
              testId="page-sandbox-detail-dialog-updated-at"
            />
            <Field label="套接字路径" value={detail.socket_path} testId="page-sandbox-detail-socket-path" />
            <Field
              label="容器内挂载点"
              value={detail.socket_mount_path}
              testId="page-sandbox-detail-socket-mount-path"
            />
            <Field
              label="工作目录"
              value={orPlaceholder(detail.workdir)}
              testId="page-sandbox-detail-workdir"
            />
            <Field
              label="启动命令"
              value={detail.command.length > 0 ? detail.command.join(' ') : orPlaceholder('')}
              testId="page-sandbox-detail-command"
            />
            <Field
              label="子 ID 段"
              value={`${detail.subid_start} 起 ${detail.subid_length} 个`}
              testId="page-sandbox-detail-subid"
            />
            <Field
              label="网络由平台自建"
              value={formatBoolean(detail.network_owned)}
              testId="page-sandbox-detail-network-owned"
            />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-medium">环境变量</h3>
              <span className="text-[11.5px] text-muted-foreground">值已脱敏，只显示键名</span>
            </div>
            {Object.keys(detail.env).length === 0 ? (
              <p className="mt-1.5 text-[12.5px] text-muted-foreground" data-testid="page-sandbox-detail-env-empty">
                （无环境变量）
              </p>
            ) : (
              <ul className="mt-1.5 m-0 list-none space-y-1 p-0" data-testid="page-sandbox-detail-env">
                {Object.keys(detail.env).map((key) => (
                  <li key={key} className="font-mono text-[12px]" data-testid="page-sandbox-detail-env-item">
                    {key}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="text-[13px] font-medium">挂载</h3>
            {detail.mounts.length === 0 ? (
              <p className="mt-1.5 text-[12.5px] text-muted-foreground" data-testid="page-sandbox-detail-mounts-empty">
                （无挂载）
              </p>
            ) : (
              <ul className="mt-1.5 m-0 list-none space-y-1 p-0" data-testid="page-sandbox-detail-mounts">
                {detail.mounts.map((mount) => (
                  <li
                    key={`${mount.role}:${mount.container_path}`}
                    className="font-mono text-[12px]"
                    data-testid="page-sandbox-detail-mount-item"
                  >
                    {mount.host_path} → {mount.container_path}
                    {mount.read_only ? '（只读）' : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="text-[13px] font-medium">依赖容器</h3>
            {detail.dependency_containers.length === 0 ? (
              <p
                className="mt-1.5 text-[12.5px] text-muted-foreground"
                data-testid="page-sandbox-detail-dependencies-empty"
              >
                （无依赖容器）
              </p>
            ) : (
              <ul
                className="mt-1.5 m-0 list-none space-y-1 p-0"
                data-testid="page-sandbox-detail-dependencies"
              >
                {detail.dependency_containers.map((name) => (
                  <li key={name} className="font-mono text-[12px]" data-testid="page-sandbox-detail-dependency-item">
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </ModalShell>
  );
}
