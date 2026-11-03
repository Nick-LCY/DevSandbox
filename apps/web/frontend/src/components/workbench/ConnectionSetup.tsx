import { Loader2, Plug } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../api/client';
import {
  clearPendingConnection,
  DESKTOP_BASE_URL_REQUIRED_ERROR,
  describeHealthFailure,
  readPendingConnection,
  syncDesktopBackend,
  validateBaseUrl,
  writePendingConnection,
  type ConnectionConfig,
} from '../../lib/connection';
import { useToast } from '../Toast';
import { Input } from '../ui/input';

interface ConnectionSetupProps {
  /** 当前已存的连接配置（引导面板拿它做初值）。 */
  config: ConnectionConfig;
  /**
   * 是否运行在桌面壳里。
   *
   * 只管**桌面运行时的那一套**（CSP 同步与待验证配置的体检流程）与
   * 「基址必填」这一条（桌面壳与后端不同源）——两种形态都能填后端地址。
   */
  desktop: boolean;
  /** 保存配置（保存后工作台才挂载）。 */
  onSave: (next: ConnectionConfig) => void;
}

/**
 * 未配置态的引导面板：后端地址 + 访问令牌 + 「保存并连接」。
 *
 * **这是页面状态，不是路由**：地址栏仍然是 `#/`，刷新页面回到这里。
 *
 * 配置口径（2026-11-03 起两种形态不再有差别）：
 * - 后端地址**两种形态都能填**：留空 = 与本页面同源，填了就连那台主机
 *   （**桌面形态例外**：桌面壳与后端不同源，基址必填，见本段末尾）；
 * - 访问令牌必填（后端对全部 `/api` 生效，没有令牌就换不到数据）。
 *
 * 「保存并连接」的动作口径：**先体检再保存**——只有健康检查通过才保存配置、
 * 才挂载工作台；不通过就**就地红字**报错（区分「令牌无效」与「后端不可达」），
 * 配置不落盘、工作台不挂载。
 *
 * 桌面形态还有一步「先同步 CSP 再体检」：后端主机是运行期才知道的，桌面壳按它
 * 生成主文档的 `connect-src`；主文档的 CSP 变了就得重载主文档，重载后才谈得上
 * 跨主机的健康检查。草稿先落在「待验证配置」里，重载回来时用它体检——
 * 时序契约见 `apps/desktop/README.md` 的「CSP」一节。
 *
 * **桌面形态下基址必填**：桌面壳与后端不同源，基址留空 = 请求打到桌面壳自己
 * （重载后必然 404，体检只会报一句误导人的「后端不可达」）。所以留空时**就地红字**
 * 拦下，不进「写 pending → 同步 CSP → 重载 → 体检」那套流程。网页形态留空照旧
 * （= 同源，直接体检）。
 */
export function ConnectionSetup({ config, desktop, onSave }: ConnectionSetupProps) {
  const { show } = useToast();
  const [baseUrl, setBaseUrl] = useState(config.backendBaseUrl);
  const [token, setToken] = useState(config.token);
  /** 本地表单校验红字（就地展示，不走 toast）。 */
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** 重载回来后的体检进行中。 */
  const [verifying, setVerifying] = useState(false);
  /** 体检只跑一次（挂载时那一轮）：避免依赖 effect 的依赖数组。 */
  const verifiedRef = useRef(false);

  /**
   * 桌面形态：重载回来时体检「待验证配置」。
   *
   * 待验证配置是桌面形态首次保存时写下的草稿：主文档重载前写的，
   * 重载后这一版 CSP 已经放行了后端主机，这时才体检得动。
   * **体检通过才提升为生效配置**（不通过就不保存、不挂载工作台）。
   */
  useEffect(() => {
    if (!desktop || verifiedRef.current) {
      return;
    }
    const pending = readPendingConnection();
    if (!pending) {
      return;
    }
    verifiedRef.current = true;
    setVerifying(true);
    void (async () => {
      try {
        await api.health(pending);
        clearPendingConnection();
        onSave(pending);
        show('success', '连接成功', { source: 'connection' });
      } catch (exc) {
        // 体检没过：配置不落盘、工作台不挂载，错误就地展示。
        clearPendingConnection();
        setError(describeHealthFailure(exc));
        // 把草稿回填进表单：用户改一下令牌就能再试。
        setBaseUrl(pending.backendBaseUrl);
        setToken(pending.token);
      } finally {
        setVerifying(false);
      }
    })();
  }, [desktop, onSave, show]);

  const save = useCallback(async () => {
    // 桌面形态：基址留空 = 请求打到桌面壳自己（桌面壳与后端不同源）。
    // 这时进「写 pending → 同步 CSP → 重载 → 体检」只会得到一句误导人的
    // 「后端不可达」（重载后必然 404）——就地红字，要求先填基址。
    if (desktop && baseUrl.trim() === '') {
      setError(DESKTOP_BASE_URL_REQUIRED_ERROR);
      return;
    }
    const baseError = validateBaseUrl(baseUrl);
    if (baseError) {
      setError(baseError);
      return;
    }
    if (token.trim() === '') {
      setError('请填写访问令牌');
      return;
    }
    setError('');
    setBusy(true);
    const next: ConnectionConfig = {
      backendBaseUrl: baseUrl.trim(),
      token: token.trim(),
    };
    if (desktop) {
      // 桌面形态：先把后端主机告诉桌面壳（动态 CSP 跟着连接配置走）。
      // 草稿先落盘：主文档重载会清掉内存状态，重载回来时靠它体检。
      writePendingConnection(next);
      const outcome = await syncDesktopBackend(next.backendBaseUrl);
      if (outcome === 'reloading') {
        // 主文档正在重载：这一轮到此为止（重载后体检，通过才保存）。
        return;
      }
    }
    // 体检：通过才保存（后端不可达 / 令牌无效 → 就地红字，不保存、不挂载工作台）。
    try {
      await api.health(next);
    } catch (exc) {
      clearPendingConnection();
      setError(describeHealthFailure(exc));
      setBusy(false);
      return;
    }
    clearPendingConnection();
    onSave(next);
    show('success', '连接成功', { source: 'connection' });
    setBusy(false);
  }, [baseUrl, desktop, onSave, show, token]);

  return (
    <div
      data-console-shell=""
      className="flex h-screen items-center justify-center bg-background p-6 text-foreground"
      data-testid="page-connection-setup"
    >
      <div className="w-full max-w-[440px] rounded-xl border border-border bg-card p-6 shadow-md">
        <div className="mb-3 flex items-center gap-2.5">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Plug className="size-4" aria-hidden="true" />
          </div>
          <h1 className="text-[15px] font-semibold">连接后端服务</h1>
        </div>
        <div className="mt-5 space-y-4">
          <div>
            <label
              htmlFor="connection-base-url"
              className="mb-1.5 block text-[12.5px] font-medium text-foreground"
            >
              后端地址
            </label>
            <Input
              id="connection-base-url"
              value={baseUrl}
              autoComplete="off"
              spellCheck={false}
              placeholder="http://127.0.0.1:8000（留空 = 与本页面同源）"
              onChange={(event) => setBaseUrl(event.target.value)}
              data-testid="page-connection-base-url-input"
            />
          </div>

          <div>
            <label
              htmlFor="connection-token"
              className="mb-1.5 block text-[12.5px] font-medium text-foreground"
            >
              访问令牌
            </label>
            <Input
              id="connection-token"
              type="password"
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder="粘贴后端部署处的访问令牌"
              onChange={(event) => setToken(event.target.value)}
              data-testid="page-connection-token-input"
            />
          </div>
        </div>

        {error && (
          <p
            className="mt-3 text-[12.5px] text-destructive"
            role="alert"
            data-testid="page-connection-error"
          >
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || verifying}
          data-testid="page-connection-submit-button"
          className="mt-5 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-transparent bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        >
          {busy || verifying ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              正在连接
            </>
          ) : (
            '保存并连接'
          )}
        </button>
      </div>
    </div>
  );
}
