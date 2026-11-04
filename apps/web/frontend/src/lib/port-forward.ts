/**
 * 端口转发的纯逻辑：本机端口校验、状态文案、本机地址拼接、圆点配色。
 *
 * 口径来源：`docs/tasks/phase3-desktop/06-port-forward-desktop.md`（决策 C 修订）、
 * `docs/architecture/decisions/0014-端口转发机制选型.md` 第 4 节、
 * `apps/web/backend/API.md` 第 15 章（隧道协议）。
 *
 * **本机端口规则**（ADR 0014 第 4 节）：
 * - **默认 = 容器端口**；
 * - **可编辑、不可为空**（空值视为非法输入，表单层拦截）；
 * - **被占自动换空闲端口**：换完**显示实际值**（界面不得显示用户输入值）；
 * - **允许 <1024**（低端口）：Windows 可绑、macOS 现代版可绑；
 *   Linux 上非 root 绑不了——那种情况由**桌面端明确报错**，不是这里的校验拦。
 *
 * **界面口径（本轮重排）**：端口转发区改成五列表格，状态从「带文字徽标」改成
 * **纯圆点 + tooltip**：圆点的配色与提示文案都在这里收口，组件只负责摆位置。
 *
 * 这里只放**纯函数**：不碰 DOM、不发请求、不读运行时形态。
 */

/** 本机监听的绑定主机：**只绑回环**，不出本机（ADR 0014 第 1 节）。 */
export const LOCAL_FORWARD_HOST = '127.0.0.1';

/** 端口下限。 */
export const PORT_MIN = 1;

/** 端口上限。 */
export const PORT_MAX = 65535;

/**
 * 校验端口：非空、纯数字、`1~65535`。
 *
 * 返回空串表示合法，否则返回中文原因（就地展示的红字）。
 *
 * **不拦低端口**（<1024 允许）：能不能绑由操作系统说了算，绑不上时桌面端
 * 会明确报错（Linux 非 root 绑不了低端口）。
 *
 * @param label 字段名（错误文案里用，如「容器端口」/「本机端口」）。
 */
export function validatePort(raw: string, label = '端口'): string {
  const text = raw.trim();
  if (text === '') {
    return `请填写${label}`;
  }
  if (!/^\d+$/.test(text)) {
    return `${label}只能是数字`;
  }
  const port = Number(text);
  if (port < PORT_MIN || port > PORT_MAX) {
    return `${label}必须在 ${PORT_MIN}~${PORT_MAX} 之间`;
  }
  return '';
}

/** 解析端口：不是合法端口时返回 `null`（空串、非法字符、超范围都算非法）。 */
export function parsePort(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    return null;
  }
  return port;
}

/** 本机访问地址的「主机:端口」形态（提示文案里用，不带协议头）。 */
export function localForwardEndpoint(port: number): string {
  return `${LOCAL_FORWARD_HOST}:${port}`;
}

/** 本机访问地址（**只在本机回环可达**）。 */
export function localForwardUrl(port: number): string {
  return `http://${localForwardEndpoint(port)}`;
}

/** 后端转发记录的状态文案（`running` / `stopped`）。 */
export function forwardStateLabel(state: string): string {
  switch (state) {
    case 'running':
      return '可用';
    case 'stopped':
      return '已停止';
    default:
      return '未知';
  }
}

/**
 * 本机监听的状态语义：**四色**（运行 / 启动中·停止中 / 已停止 / 失败）。
 *
 * 颜色一律走状态色令牌（`text-status-*`），不写裸色值。
 */
export type ForwardTone = 'running' | 'busy' | 'stopped' | 'failed';

/** 监听状态 → 四色语义。 */
export function listenerTone(state: string): ForwardTone {
  switch (state) {
    case 'listening':
      return 'running';
    case 'starting':
      return 'busy';
    case 'stopped':
      return 'stopped';
    case 'error':
      return 'failed';
    default:
      return 'stopped';
  }
}

/** 四色语义 → 状态色类名。 */
export function listenerToneClass(tone: ForwardTone): string {
  switch (tone) {
    case 'running':
      return 'text-status-running';
    case 'busy':
      return 'text-status-busy animate-status-pulse';
    case 'stopped':
      return 'text-status-stopped';
    case 'failed':
      return 'text-status-failed';
    default:
      return 'text-status-stopped';
  }
}

/** 本机监听的状态文案。 */
export function listenerStateLabel(state: string): string {
  switch (state) {
    case 'listening':
      return '监听中';
    case 'starting':
      return '开启中';
    case 'stopped':
      return '未开启';
    case 'error':
      return '失败';
    default:
      return '未开启';
  }
}

/**
 * 本机监听徽标的状态（**颜色与文字同源**）。
 *
 * - `starting`：开启中（琥珀，脉动）；
 * - `listening`：监听中（绿）；
 * - `error`：开启失败（红）；
 * - `stopped`：未开启（灰）。
 */
export type ListenerBadgeState = 'starting' | 'listening' | 'error' | 'stopped';

/**
 * 算本机监听徽标的状态。
 *
 * **徽标只表达本机监听语义**：后端转发记录的状态（running / 已停止）是
 * 另一回事，单独一列展示，不进本机状态——混进来会出现「灰点 +『可用』」
 * 这种颜色与文字自相矛盾的呈现。
 *
 * - 正在开启 → `starting`；
 * - 已在监听 → `listening`（**即使刚有隧道失败**，监听器还在，仍是绿）；
 * - 没在监听、但有失败原因 → `error`；
 * - 其余 → `stopped`。
 */
export function listenerBadgeState(input: {
  /** 是否正在开启监听。 */
  starting: boolean;
  /** 是否已在监听。 */
  listening: boolean;
  /** 是否有失败原因（开启失败 / 隧道致命失败）。 */
  failed: boolean;
}): ListenerBadgeState {
  if (input.starting) {
    return 'starting';
  }
  if (input.listening) {
    return 'listening';
  }
  if (input.failed) {
    return 'error';
  }
  return 'stopped';
}

/**
 * 本机状态圆点的配色（表格里的纯圆点，无文字）。
 *
 * **只有三色**：绿（监听中）/ 黄（开启中，脉动）/ 红（未开启、失败）。
 *
 * **未开启是红点**：转发记录在、后端可用，但本机没有监听——这是**待处理**的
 * 状态，不是「一切正常」。（灰色的「已停止」语义只留给沙箱本身。）
 *
 * 配色仍走 `listenerTone` / `listenerToneClass` 两层，不写裸色值。
 */
export function listenerDotClass(state: ListenerBadgeState): string {
  const tone: ForwardTone = state === 'stopped' ? 'failed' : listenerTone(state);
  return listenerToneClass(tone);
}

/**
 * 本机状态圆点的提示文案（tooltip 内容，同时作为圆点的可访问名）。
 *
 * @param state 本机监听状态（`listenerBadgeState` 的四态）。
 * @param localPort 实际生效的本机端口（监听中时带上）。
 */
export function listenerStateHint(state: ListenerBadgeState, localPort: number | null): string {
  switch (state) {
    case 'starting':
      return '正在开启本机监听…';
    case 'listening':
      return localPort === null
        ? listenerStateLabel('listening')
        : `${listenerStateLabel('listening')} · ${localForwardEndpoint(localPort)}`;
    case 'error':
      return '本机监听失败';
    case 'stopped':
      return '本机监听未开启';
    default:
      return listenerStateLabel('stopped');
  }
}

/**
 * 后端转发记录的**容器状态**（表格里那一列）。
 *
 * - `running`：后端转发可用；
 * - `stopped`：后端转发已停止；
 * - `orphan`：**本机在听、后端没有记录**（记录被删了，本机监听还在）。
 */
export type ForwardRecordState = 'running' | 'stopped' | 'orphan';

/**
 * 算容器状态。
 *
 * @param state 后端记录的状态（`running` / `stopped`）；**没有记录**（`undefined`）
 *              按孤儿行算。
 */
export function forwardRecordState(state: string | undefined): ForwardRecordState {
  if (state === undefined) {
    return 'orphan';
  }
  return state === 'running' ? 'running' : 'stopped';
}

/** 容器状态的提示文案（tooltip 内容，同时作为圆点的可访问名）。 */
export function forwardRecordStateLabel(state: ForwardRecordState): string {
  if (state === 'orphan') {
    return '无后端转发记录';
  }
  return `后端转发${forwardStateLabel(state)}`;
}

/**
 * 容器状态圆点的配色（表格里的纯圆点，无文字）。
 *
 * **不用脉动**：后端转发记录没有中间态（可用 / 已停 / 无记录三态）。
 */
export function forwardRecordDotClass(state: ForwardRecordState): string {
  const tone: ForwardTone = state === 'running' ? 'running' : 'failed';
  return listenerToneClass(tone);
}

/**
 * 开启本机监听后的提示文案。
 *
 * **被占自动换端口时要说清楚**：界面显示的必须是**实际生效的端口**
 * （用户输入的端口可能已经被别的进程占了）。
 */
export function describeListenerStarted(requested: number, actual: number): string {
  if (requested === actual) {
    return `本机监听已开启：${localForwardUrl(actual)}`;
  }
  return `本机端口 ${requested} 已被占用，已自动改用 ${actual}：${localForwardUrl(actual)}`;
}
