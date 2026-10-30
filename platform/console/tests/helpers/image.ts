/**
 * 现场在宿主构建一个「不存在于任何仓库」的测试镜像。
 *
 * 镜像名带一次性随机后缀：这样的名字在任何镜像仓库里都不可能存在，
 * 沙箱里能拿到它就只能是宿主导出注入的产物（注入路径走通的直接证据）。
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface BuiltImage {
  /** 完整镜像引用。 */
  reference: string;
  /** 镜像 ID。 */
  imageId: string;
  /** 镜像体积（字节）。 */
  sizeBytes: number;
  /** 构建耗时（毫秒）。 */
  buildMs: number;
  /** `docker manifest inspect` 的结果（用于佐证该镜像不在任何仓库）。 */
  manifestProbe: string;
}

const DOCKERFILE = `FROM debian:bookworm-slim
LABEL console.acceptance="local-only-image"
RUN echo "console-acceptance local-only image" > /etc/console-acceptance-marker
`;

/** 构建本地专属测试镜像。 */
export function buildLocalOnlyImage(): BuiltImage {
  const suffix = crypto.randomBytes(4).toString('hex');
  const reference = `sandbox-console-acceptance/local-only-${suffix}:0.1.0`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-acceptance-image-'));
  try {
    fs.writeFileSync(path.join(dir, 'Dockerfile'), DOCKERFILE, 'utf-8');
    const started = Date.now();
    const build = spawnSync('docker', ['build', '-t', reference, dir], {
      encoding: 'utf-8',
      timeout: 900_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (build.status !== 0) {
      throw new Error(`构建测试镜像失败（退出码 ${build.status}）：${build.stderr || build.stdout}`);
    }
    const buildMs = Date.now() - started;
    const inspect = spawnSync(
      'docker',
      ['image', 'inspect', reference, '--format', '{{.Id}}\t{{.Size}}'],
      { encoding: 'utf-8', timeout: 120_000 },
    );
    if (inspect.status !== 0) {
      throw new Error(`读取测试镜像信息失败：${inspect.stderr}`);
    }
    const [imageId, sizeText] = inspect.stdout.trim().split('\t');
    // 该镜像在任何仓库里都不存在：向仓库探一次，失败即佐证
    const manifest = spawnSync('docker', ['manifest', 'inspect', reference], {
      encoding: 'utf-8',
      timeout: 180_000,
    });
    const manifestProbe =
      manifest.status === 0
        ? 'manifest inspect 成功（意外：仓库里居然有同名镜像）'
        : `manifest inspect 失败（退出码 ${manifest.status}）：${(manifest.stderr || manifest.stdout).trim().split('\n')[0]}`;
    return {
      reference,
      imageId: imageId.trim(),
      sizeBytes: Number.parseInt(sizeText.trim(), 10),
      buildMs,
      manifestProbe,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 删掉测试镜像。 */
export function removeImage(reference: string): void {
  spawnSync('docker', ['image', 'rm', '-f', reference], {
    encoding: 'utf-8',
    timeout: 300_000,
  });
}
