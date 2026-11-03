/**
 * 后端接口的数据形状。
 *
 * 字段名与 `apps/web/backend/src/sandbox_console/schemas.py` 一一对应，
 * 后端用蛇形命名，前端不做转换（少一层映射就少一处出错的地方）。
 */

/** 列表项：名字 / 状态 / 镜像 / 创建时间。 */
export interface SandboxSummary {
  name: string;
  state: string;
  state_label: string;
  image: string;
  created_at: string;
}

/** 用户声明的挂载。 */
export interface MountInfo {
  host_path: string;
  container_path: string;
  read_only: boolean;
  role: string;
}

/** 单个沙箱的完整信息。`env` 只回键名，值固定为 `***`。 */
export interface SandboxDetail {
  name: string;
  state: string;
  state_label: string;
  image: string;
  image_source: string;
  created_at: string;
  updated_at: string;
  system_user: string;
  uid: number;
  gid: number;
  home: string;
  subid_start: number;
  subid_length: number;
  socket_path: string;
  socket_mount_path: string;
  container_name: string;
  container_id: string;
  network_name: string;
  network_owned: boolean;
  unit_path: string;
  mounts: MountInfo[];
  dependency_containers: string[];
  command: string[];
  env: Record<string, string>;
  workdir: string;
}

/** 沙箱连接方式与命令提示。 */
export interface ConnectionInfo {
  socket_path: string;
  container_name: string;
  exec_command: string;
  docker_command: string;
  notes: string[];
}

/** 创建沙箱的结果：`steps` 是固定 7 步名称。 */
export interface CreateSandboxResponse {
  metadata: SandboxDetail;
  connection: ConnectionInfo;
  steps: string[];
}

/** 删除前的回收清单。 */
export interface ReclaimPlan {
  sandbox_name: string;
  items: string[];
  untouched_note: string;
  user_mounts: string[];
  incomplete: boolean;
}

/** 删除沙箱的结果。 */
export interface DeleteSandboxResponse {
  name: string;
  existed: boolean;
  removed: string[];
  failed: string[];
  plan: ReclaimPlan | null;
}

/** 服务自检。 */
export interface HealthResponse {
  status: string;
  version: string;
  data_root_configured: boolean;
  console_mounted: boolean;
}

/** 宿主本地镜像项。 */
export interface HostImage {
  reference: string;
  image_id: string;
  size_bytes: number;
  created_at: string;
}

/** 代理容器的存在与运行状态。 */
export interface ProxyContainerStatus {
  exists: boolean;
  running: boolean;
}

/** 代理状态。 */
export interface ProxyStatus {
  container: ProxyContainerStatus;
  healthy: boolean;
  tcp_ok: boolean;
  ca_fetchable: boolean;
  detail: string;
  cache_size_bytes: number;
  certificate_ready: boolean;
  proxy_url: string;
}

/** 重启代理的结果：状态字段 + CA 相关结论。 */
export interface ProxyRestartResult extends ProxyStatus {
  restarted: boolean;
  ca_changed: boolean;
  ca_reinstalled: boolean;
  message: string;
  reinstalled_users: string[];
  failed_users: string[];
}

/** 新建终端会话的结果。 */
export interface TerminalSession {
  session_id: string;
  sandbox: string;
  container_name: string;
  cols: number;
  rows: number;
  state: string;
  created_at: string;
}

/** 终端会话表的一行（会话元数据）。 */
export interface TerminalSessionRecord {
  session_id: string;
  sandbox_name: string;
  container_name: string;
  system_user: string;
  created_at: string;
  last_attached_at: string;
  state: string;
  exit_code: number | null;
  /** 会话结束的原因（未结束为空）：exited / closed_by_user / reclaimed / shutdown。 */
  exit_reason: string | null;
  pid: number;
  cols: number;
  rows: number;
  attached_count: number;
  host_pid: number;
}

/** 删除终端会话的结果。 */
export interface TerminalSessionDeleteResult {
  session_id: string;
  /** 移除前的会话状态（running / exited）。 */
  state: string;
  /** 关闭流程是否走完（false = 记录已删，但关闭流程未走完）。 */
  closed: boolean;
  /** 会话记录文件是否确实删掉了。 */
  removed: boolean;
}

/** 创建沙箱的请求体。字段与后端 `CreateSandboxRequest` 一致。 */
export interface CreateSandboxRequest {
  name: string;
  image?: string | null;
  image_source?: 'auto' | 'host';
  mounts?: string[];
  /**
   * 注入文件声明，格式 `宿主路径:容器路径`（固定两段）。
   *
   * 平台把宿主文件复制到沙箱用户家目录后，以只读方式挂进容器。
   */
  files?: string[];
  /**
   * 容器启动命令。
   *
   * 字符串按 shell 引号规则切分；数组原样当参数元组用（后端契约两种都收）。
   */
  command?: string | string[] | null;
  env?: Record<string, string>;
  workdir?: string | null;
  network?: string | null;
}

/**
 * 启动模板的配置体（七项全选填）。
 *
 * **字段缺失与字段填了空值不是一回事**：用户没填过的字段不会出现在
 * 配置体里（服务端按 `exclude_unset` 落盘），前端合并时也按「出现即
 * 整体替换、缺失即保持现状」处理。
 */
export interface TemplateConfig {
  image?: string | null;
  mounts?: string[];
  /**
   * 注入文件声明，格式 `宿主路径:容器路径`（固定两段）。
   *
   * 平台把宿主文件复制到沙箱用户家目录后，以只读方式挂进容器。
   */
  files?: string[];
  /**
   * 容器启动命令。
   *
   * **字符串与字符串数组都合法**（后端契约 `str | list[str] | null`）：
   * 字符串按 shell 引号规则切分，数组原样当参数元组用。数组命令在前端
   * 没有对应的输入框（表单只有一行命令输入框），加载模板时进隐藏状态透传。
   */
  command?: string | string[] | null;
  workdir?: string | null;
  env?: Record<string, string>;
  network?: string | null;
}

/** 启动模板。标识由服务端生成，与名称解耦（重命名不影响标识）。 */
export interface Template {
  id: string;
  name: string;
  config: TemplateConfig;
  created_at: string;
  updated_at: string;
}

/** 删除模板的结果：`deleted` 是模板记录文件是否确实删掉了。 */
export interface TemplateDeleteResult {
  id: string;
  deleted: boolean;
}

/**
 * 一次性票据（`POST /api/auth/ticket`）。
 *
 * 浏览器发起的 WebSocket 不能设自定义头，所以先用 Bearer 换一张票据，
 * 再以 `?ticket=` 带上；票据 30 秒过期、用过即废。
 */
export interface AuthTicketResponse {
  /** 票据本体。 */
  ticket: string;
  /** 有效期（秒）。 */
  expires_in: number;
}
