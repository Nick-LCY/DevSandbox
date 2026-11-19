/**
 * 终端实例的**常驻口径**（标签之间常驻）。
 *
 * 背景：切换终端标签过去会让终端**整块重挂载**（`key={activeId}`）——
 * 旧的 xterm 实例连同它身上的终端模式（鼠标上报 / 焦点上报 / 括号粘贴 /
 * 备用屏）与滚动现场一起被丢掉，新实例只能靠重放服务端缓冲把画面拼回来。
 * 常驻之后：**访问过的会话保留自己的 xterm 实例**，切标签只是把它藏起来
 * （`display:none`），不再销毁重建。
 *
 * 口径（纯函数，可单测）：
 *
 * - **挂载集合 = （已访问过且仍在会话表里）∪ 当前激活**：
 *   - 已访问过的会话保留实例（会话被关掉 ⇒ 掉出集合，实例随之卸载）；
 *   - 当前激活的会话**恒在集合里**（哪怕它还没被访问过——比如直接用链接
 *     打开某个会话）；
 *   - 没访问过的会话**不挂载**（不自动附着用户没点过的会话）。
 * - **顺序按会话表**（= 标签顺序）：挂载集合的顺序与标签顺序一致，
 *   DOM 顺序稳定，切换时不会整列错位。
 *
 * 纯函数，不碰 DOM、不碰网络：常驻口径收敛在本文件。
 */

/** 常驻口径的输入。 */
export interface TerminalResidencyInput {
  /** 会话表里的会话标识（顺序 = 标签顺序）。 */
  sessionIds: string[];
  /** 已经访问过的会话标识（用户点过的那些）。 */
  visited: string[];
  /** 当前激活的会话标识（没有激活会话时为 null）。 */
  activeId: string | null;
}

/**
 * 算当前该挂载哪些会话（按会话表顺序）。
 *
 * @param input 会话表 / 已访问集合 / 当前激活会话
 */
export function resolveMountedSessions(input: TerminalResidencyInput): string[] {
  const { sessionIds, visited, activeId } = input;
  const visitedSet = new Set(visited);
  const mounted: string[] = [];
  for (const sessionId of sessionIds) {
    // 已访问（且还在会话表里）⇒ 常驻；当前激活 ⇒ 恒挂载。
    if (visitedSet.has(sessionId) || sessionId === activeId) {
      mounted.push(sessionId);
    }
  }
  if (activeId !== null && !mounted.includes(activeId)) {
    // 激活会话还不在会话表里（会话表这一轮还没读到）：它仍要挂载，
    // 追加在末尾（会话表里没有它，顺序上只能靠后）。
    mounted.push(activeId);
  }
  return mounted;
}

/**
 * 把一个会话登记进「已访问」集合（**幂等**）。
 *
 * 已经登记过的会话原样返回**同一个数组引用**：调用方可以直接把它交给
 * `setState`——同引用会被 React 的 bailout 跳过，不会多跑一轮渲染。
 */
export function markVisited(visited: string[], sessionId: string): string[] {
  if (sessionId === '' || visited.includes(sessionId)) {
    return visited;
  }
  return [...visited, sessionId];
}
