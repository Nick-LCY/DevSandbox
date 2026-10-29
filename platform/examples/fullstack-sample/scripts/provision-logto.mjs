#!/usr/bin/env node
/**
 * Logto 供应脚本：预置一个授权码应用与一个已知口令的测试用户。
 *
 * 供应方式（实际采用）：**管理 API + 种子自带的机器对机器应用**。
 *
 *   1. Logto 首次初始化时（`logto db seed`）会为「默认租户的管理接口」预置一个
 *      机器对机器应用 `m-default`，它的客户端密钥写在数据库的 applications 表里。
 *   2. 本脚本从数据库读出该密钥，到 **管理租户**（端口 3002）的 token 端点做
 *      client_credentials 换取「管理接口访问令牌」——这是真实的 OAuth2 客户端凭证流程。
 *   3. 拿令牌调用管理 API（端口 3001 的默认租户）：
 *      `POST /api/applications` 建授权码应用，`POST /api/users` 建测试用户。
 *
 * 为什么不用管理后台网页手工点：验收要求无人值守，且管理后台首次登录还要先注册管理员，
 * 机器对机器应用是 Logto 官方种子自带的、可脚本化的最短路径。
 *
 * 环境变量：
 *   LOGTO_ADMIN_ENDPOINT   管理租户地址（默认 http://logto:3002）
 *   LOGTO_ENDPOINT         默认租户地址（默认 http://logto:3001）
 *   LOGTO_MANAGEMENT_RESOURCE  管理接口资源标识（默认 https://default.logto.app/api）
 *   PG_CONTAINER / PG_USER / PG_DB  读种子密钥用的 postgres 容器与库
 *   LOGTO_APP_NAME / LOGTO_REDIRECT_URI / LOGTO_POST_LOGOUT_URI
 *   LOGTO_USERNAME / LOGTO_PASSWORD / LOGTO_EMAIL / LOGTO_USER_NAME
 *   OUTPUT                 供应结果 JSON 的落地路径
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;

const adminEndpoint = (env.LOGTO_ADMIN_ENDPOINT ?? 'http://logto:3002').replace(/\/$/, '');
const endpoint = (env.LOGTO_ENDPOINT ?? 'http://logto:3001').replace(/\/$/, '');
const managementResource = env.LOGTO_MANAGEMENT_RESOURCE ?? 'https://default.logto.app/api';
const pgContainer = env.PG_CONTAINER ?? 'postgres';
const pgUser = env.PG_USER ?? 'postgres';
const pgDb = env.PG_DB ?? 'logto';
const appName = env.LOGTO_APP_NAME ?? '全栈示例应用';
const redirectUri = env.LOGTO_REDIRECT_URI ?? 'https://app:8000/auth/callback';
const postLogoutUri = env.LOGTO_POST_LOGOUT_URI ?? 'https://app:8000/';
const username = env.LOGTO_USERNAME ?? 'sampleuser';
const password = env.LOGTO_PASSWORD ?? 'SamplePass123!';
const userName = env.LOGTO_USER_NAME ?? '示例用户';
const email = env.LOGTO_EMAIL ?? 'sample@example.com';
const outputPath = env.OUTPUT ?? '/opt/sample/config/logto-provision.json';

function log(message) {
  process.stdout.write(`[logto] ${message}\n`);
}

function readSeedSecret() {
  const sql = "select secret from applications where id = 'm-default';";
  const out = execFileSync(
    'docker',
    ['exec', pgContainer, 'psql', '-U', pgUser, '-d', pgDb, '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  );
  return out.trim();
}

async function request(url, init = {}) {
  const response = await fetch(url, { ...init });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} → ${response.status}：${text.slice(0, 400)}`);
  }
  return body;
}

async function waitForLogto() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const body = await request(`${adminEndpoint}/oidc/.well-known/openid-configuration`);
      if (body?.issuer) {
        log(`Logto 管理租户就绪：${body.issuer}`);
        return;
      }
    } catch {
      // 还没起来，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Logto 管理租户 120 秒内未就绪');
}

async function fetchManagementToken(secret) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: 'm-default',
    client_secret: secret,
    scope: 'all',
    resource: managementResource,
  });
  const result = await request(`${adminEndpoint}/oidc/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!result?.access_token) {
    throw new Error('没有拿到管理接口访问令牌');
  }
  return result.access_token;
}

async function ensureApplication(token) {
  const list = await request(`${endpoint}/api/applications`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const existing = (list ?? []).find((item) => item.name === appName);
  if (existing) {
    const detail = await request(`${endpoint}/api/applications/${existing.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    log(`应用已存在，复用：${detail.id}`);
    return detail;
  }
  const created = await request(`${endpoint}/api/applications`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: appName,
      description: '沙箱平台全栈示例：授权码 + PKCE 登录',
      type: 'Traditional',
      oidcClientMetadata: {
        redirectUris: [redirectUri],
        postLogoutRedirectUris: [postLogoutUri],
      },
    }),
  });
  log(`应用已创建：${created.id}`);
  return created;
}

async function ensureUser(token) {
  const list = await request(`${endpoint}/api/users`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const existing = (list ?? []).find((item) => item.username === username);
  if (existing) {
    log(`测试用户已存在，复用：${existing.id}`);
    return existing;
  }
  const created = await request(`${endpoint}/api/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username,
      password,
      name: userName,
      primaryEmail: email,
    }),
  });
  log(`测试用户已创建：${created.id}`);
  return created;
}

async function main() {
  await waitForLogto();

  const seedSecret = readSeedSecret();
  if (!seedSecret) {
    throw new Error('数据库里没有找到种子自带的 m-default 应用密钥');
  }
  log('已从数据库读出种子自带的 m-default 客户端密钥');

  const token = await fetchManagementToken(seedSecret);
  log('已通过 client_credentials 拿到管理接口访问令牌');

  const application = await ensureApplication(token);
  const user = await ensureUser(token);

  const result = {
    endpoint,
    adminEndpoint,
    issuer: `${endpoint}/oidc`,
    clientId: application.id,
    clientSecret: application.secret,
    redirectUri,
    user: { id: user.id, username: user.username, password },
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  log(`供应结果已写入 ${outputPath}`);
}

main().catch((error) => {
  process.stderr.write(`[logto] 供应失败：${error.message}\n`);
  process.exit(1);
});
