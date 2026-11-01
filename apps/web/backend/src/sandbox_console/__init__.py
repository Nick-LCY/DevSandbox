"""控制面服务层：把一期核心包包装为 HTTP 接口。

服务层只做编排与转译：请求模型负责把 HTTP 载荷翻译成核心包入参，响应模型负责
把核心包的数据类翻译成 JSON 结构，全部生命周期逻辑仍在 ``sandbox_platform``
核心包内。命令行与服务端共用同一套核心接口，行为等价。

约定：

- 服务层源码不含命令行参数解析，也不直接向标准输出打印，一律走日志。
- 宿主交互一律经核心包（``daemon.py`` / ``images.py`` / ``proxy.py``），
  服务层自己不拼任何宿主命令。
- 服务层是独立包 ``sandbox_console``（apps/web/backend），依赖方向单向：
  它依赖核心包，核心包不认识它。
"""

from __future__ import annotations

from .app import create_app

__all__ = ["create_app"]
