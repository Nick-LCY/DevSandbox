#!/usr/bin/env python3
"""最小静态页服务 —— 同一端口同时接受明文 HTTP 与 TLS。

为什么需要双协议：
    Chrome 会对 http:// 导航做一次「企业数据保护」URL 扫描，扫描走 https://，
    于是同一个 http://host:port 会同时收到明文请求与 TLS 握手。
    只讲明文的服务器会让 Chrome 报 net::ERR_SSL_PROTOCOL_ERROR。
    本服务按连接首字节分流：0x16 视为 TLS 握手，其余按明文 HTTP 处理，
    两种协议都能正常返回页面。

用法：
    APP_PORT=8000 APP_ROOT=/srv/www python3 serve.py
证书：
    /srv/www/cert.pem 与 /srv/www/key.pem（自签，仅沙箱内使用）。
"""

from __future__ import annotations

import http.server
import os
import socket
import socketserver
import ssl
import sys

PORT = int(os.environ.get("APP_PORT", "8000"))
ROOT = os.environ.get("APP_ROOT", "/srv/www")
CERT_FILE = os.environ.get("APP_CERT", os.path.join(ROOT, "cert.pem"))
KEY_FILE = os.environ.get("APP_KEY", os.path.join(ROOT, "key.pem"))


class Handler(http.server.SimpleHTTPRequestHandler):
    """静态文件处理器。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):  # noqa: D102 - 覆写以简化日志
        sys.stderr.write("[app] " + (fmt % args) + "\n")
        sys.stderr.flush()


class DualProtocolServer(socketserver.ThreadingTCPServer):
    """按首字节分流的服务器：TLS 握手走 TLS，其余走明文 HTTP。"""

    daemon_threads = True
    allow_reuse_address = True

    def get_request(self):
        sock, addr = self.socket.accept()
        try:
            first = sock.recv(1, socket.MSG_PEEK)
        except OSError:
            first = b""
        if first[:1] == b"\x16":  # TLS record 的握手类型
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(CERT_FILE, KEY_FILE)
            try:
                sock = context.wrap_socket(sock, server_side=True)
            except OSError as error:
                sys.stderr.write(f"[app] TLS 握手失败：{error}\n")
                sock.close()
                raise
        return sock, addr


def main() -> int:
    server = DualProtocolServer(("0.0.0.0", PORT), Handler)
    sys.stderr.write(f"[app] 静态页服务已启动：端口 {PORT}，根目录 {ROOT}（明文与 TLS 同时接受）\n")
    sys.stderr.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
