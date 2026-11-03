# 架构

本目录存放系统设计与架构决策（稳定层，很少变更）。

## 内容
- [[architecture/overview.md]] — 系统总览（分层结构、核心模块、关键决策）
- [[architecture/decisions/README.md]] — 架构决策记录（ADR）清单与模板

## 清单

| 编号 | 决策 | 状态 |
|---|---|---|
| 0001 | [[architecture/decisions/0001-项目定位与三期路线.md\|项目定位与三期路线]] | 已接受 |
| 0002 | [[architecture/decisions/0002-依赖容器化策略.md\|依赖容器化策略]] | 已接受 |
| 0003 | [[architecture/decisions/0003-每沙箱专属用户与免root守护进程.md\|每沙箱专属用户与免 root 守护进程]] | 已接受 |
| 0004 | [[architecture/decisions/0004-镜像契约与默认沙箱镜像.md\|镜像契约与默认沙箱镜像]] | 已接受 |
| 0005 | [[architecture/decisions/0005-挂载契约与数据归属.md\|挂载契约与数据归属]] | 已接受 |
| 0006 | [[architecture/decisions/0006-端到端测试基建策略.md\|端到端测试基建策略]] | 已接受 |
| 0007 | [[architecture/decisions/0007-范围边界与云边形态.md\|范围边界与云边形态]] | 已接受 |
| 0008 | [[architecture/decisions/0008-统一镜像代理与离线包废弃.md\|统一镜像代理与离线包废弃]] | 已接受 |
| 0009 | [[architecture/decisions/0009-二期控制台服务化与范围裁剪.md\|二期控制台服务化与范围裁剪]] | 已接受 |
| 0010 | [[architecture/decisions/0010-启动模板收敛为控制台私有功能.md\|启动模板收敛为控制台私有功能]] | 已接受 |
| 0011 | [[architecture/decisions/0011-基础镜像增加通用工具层并转联网构建.md\|基础镜像增加通用工具层并转联网构建]] | 已接受 |
| 0012 | [[architecture/decisions/0012-文件注入采用复制加改属主而非改造挂载预检.md\|文件注入采用复制加改属主而非改造挂载预检]] | 已接受 |

结论摘要见 [[architecture/overview.md#关键决策]]，决策背景与代价见 [[architecture/decisions/README.md|ADR 清单]]。

## ADR 格式
见 [[architecture/decisions/README.md]]。
