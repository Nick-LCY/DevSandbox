/**
 * 终端会话的定序与标签序号。
 *
 * 标签序号必须跟会话身份绑定，不能跟「列表里的第几个」绑定：
 * 关掉中间一个标签之后，其余标签的序号不能重排（用户正在用的那个不能改名字）。
 *
 * 定序口径：先按会话的创建时间排，同一秒并列时按会话标识排。
 * 序号口径：会话第一次被看到时按递增顺序分配，之后不再变动。
 */

/** 参与定序的最小字段。 */
export interface SessionOrderKey {
  /** 会话标识（服务端生成，全局唯一）。 */
  session_id: string;
  /** 会话创建时间（ISO 时间串）。 */
  created_at: string;
}

/** 时间戳取值：解析不了就当作最早（排在最前），不把整个列表的顺序打乱。 */
function timeValue(createdAt: string): number {
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * 按创建时间给会话定序（同一时刻创建的会话按会话标识排）。
 *
 * 返回新数组：不改调用方手里的原数组。
 */
export function sortSessionsByCreation<T extends SessionOrderKey>(records: T[]): T[] {
  return [...records].sort((left, right) => {
    const delta = timeValue(left.created_at) - timeValue(right.created_at);
    if (delta !== 0) {
      return delta;
    }
    return left.session_id.localeCompare(right.session_id);
  });
}

/**
 * 标签序号登记表：会话标识 → 序号。
 *
 * 序号按「首次见到的顺序」递增分配，之后不再变动。
 * 关掉一个会话不回收它的序号，所以其余标签不会因为少了一个而重排。
 */
export class SessionNumbering {
  private readonly numbers = new Map<string, number>();

  private next = 1;

  /** 会话的标签序号：第一次问的时候分配，之后一直给同一个号。 */
  numberOf(sessionId: string): number {
    const existing = this.numbers.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const assigned = this.next;
    this.next += 1;
    this.numbers.set(sessionId, assigned);
    return assigned;
  }

  /** 已经登记过的会话个数。 */
  get size(): number {
    return this.numbers.size;
  }
}

/** 每个沙箱一份序号登记表（模块级：面板卸载再回来，序号不变）。 */
const numberings = new Map<string, SessionNumbering>();

/** 取某个沙箱的标签序号登记表（没有就建一份）。 */
export function sessionNumbering(sandboxName: string): SessionNumbering {
  const existing = numberings.get(sandboxName);
  if (existing) {
    return existing;
  }
  const created = new SessionNumbering();
  numberings.set(sandboxName, created);
  return created;
}
