import { ModalShell } from './ModalShell';

interface PortForwardInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 「安装桌面端」指引弹窗（web 形态专用）。
 *
 * **只说三件事**：安装包从哪来、装完要填什么、开启转发后怎么访问。
 * 不重复解释端口转发的机制（那是文档的事）。
 */
export function PortForwardInstallDialog({ open, onOpenChange }: PortForwardInstallDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <ModalShell
      open={open}
      title="安装桌面端"
      testId="page-forward-install-dialog"
      onOpenChange={onOpenChange}
      maxWidthPx={440}
      footer={
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          data-testid="page-forward-install-close-button"
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          知道了
        </button>
      }
    >
      <ol className="m-0 list-decimal space-y-3 pl-5 text-[12.5px] leading-relaxed text-foreground">
        <li data-testid="page-forward-install-step-package">
          <span className="font-medium">拿安装包：</span>
          安装包由平台提供（Windows 的 NSIS 安装包），在项目发行页或交付渠道下载，
          双击安装（默认装到当前用户，无需管理员权限）。
        </li>
        <li data-testid="page-forward-install-step-config">
          <span className="font-medium">填后端地址与令牌：</span>
          装好后打开桌面端，在「设置 → 连接配置」里填上后端地址
          （默认 <code className="font-mono">http://127.0.0.1:8000</code>）与访问令牌，
          保存后桌面端会重载一次主文档（动态 CSP 需要带上后端主机）。
        </li>
        <li data-testid="page-forward-install-step-access">
          <span className="font-medium">开启转发后访问：</span>
          在沙箱详情里开启端口转发，桌面端会在本机回环上监听
          <code className="font-mono">127.0.0.1:&lt;本机端口&gt;</code>，
          浏览器直接访问 <code className="font-mono">http://127.0.0.1:&lt;本机端口&gt;</code> 即可。
        </li>
      </ol>
    </ModalShell>
  );
}
