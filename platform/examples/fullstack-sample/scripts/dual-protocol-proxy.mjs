#!/usr/bin/env node
/**
 * 双协议 TCP 转发代理：同一个端口同时接受明文与 TLS。
 *
 * 为什么需要：Chromium 会对 http:// 导航额外发一次 https:// 请求（企业数据保护 URL 扫描），
 * 只讲明文的服务会让浏览器停在 net::ERR_SSL_PROTOCOL_ERROR。
 * 做法：按连接首字节分流 —— 0x16 是 TLS 握手记录类型，走 TLS；其余按明文 TCP 转发。
 * 两条路都通，浏览器怎么升级都不影响。
 *
 * 用法：
 *   node dual-protocol-proxy.mjs --cert cert.pem --key key.pem \
 *        --map 8000:127.0.0.1:8001 --map 3001:127.0.0.1:3003
 *
 * 参数：
 *   --cert / --key  自签证书与私钥（TLS 分支用）
 *   --map           监听端口:目标主机:目标端口，可重复
 */

import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

function parseArgs(argv) {
  const options = { maps: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--map') {
      options.maps.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (item.startsWith('--')) {
      options[item.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

function log(message) {
  process.stdout.write(`[proxy] ${message}\n`);
}

/** 把一条已建立的连接转发到上游。 */
function forward(source, target) {
  const upstream = net.connect({ host: target.host, port: target.port });
  upstream.on('error', (error) => {
    log(`上游连接失败 ${target.host}:${target.port}：${error.message}`);
    source.destroy();
    upstream.destroy();
  });
  source.on('error', () => upstream.destroy());
  source.pipe(upstream);
  upstream.pipe(source);
}

function startListener(map, secureContext) {
  const [listenPort, targetHost, targetPort] = map.split(':');
  const target = { host: targetHost, port: Number(targetPort) };
  const server = net.createServer({ pauseOnConnect: true }, (client) => {
    client.on('error', () => client.destroy());

    const onReadable = () => {
      const first = client.read(1);
      if (!first) {
        return;
      }
      client.off('readable', onReadable);
      // 把读走的首字节放回缓冲区，后面照常转发。
      client.unshift(first);

      if (first[0] === 0x16 && secureContext) {
        const tlsSocket = new tls.TLSSocket(client, { isServer: true, secureContext });
        tlsSocket.on('error', () => tlsSocket.destroy());
        tlsSocket.on('secure', () => forward(tlsSocket, target));
        return;
      }
      forward(client, target);
    };

    client.on('readable', onReadable);
  });

  server.on('error', (error) => {
    log(`监听 ${listenPort} 失败：${error.message}`);
    process.exit(1);
  });

  server.listen(Number(listenPort), '0.0.0.0', () => {
    log(`监听 0.0.0.0:${listenPort} → ${target.host}:${target.port}（明文与 TLS 同时接受）`);
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.maps.length === 0) {
    log('缺少 --map 参数');
    process.exit(2);
  }

  let secureContext = null;
  if (options.cert && options.key) {
    secureContext = tls.createSecureContext({
      cert: fs.readFileSync(options.cert),
      key: fs.readFileSync(options.key),
    });
  }

  for (const map of options.maps) {
    startListener(map, secureContext);
  }
}

main();
