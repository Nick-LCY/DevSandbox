/** 前端入参校验。规则与后端白名单一致，前端先拦一道少一次往返。 */

/** 沙箱名白名单：`[a-z0-9][a-z0-9_-]{0,23}`。 */
const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/** 校验沙箱名，返回错误文案；合法时返回 `null`。 */
export function validateSandboxName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return '请填写沙箱名';
  }
  if (!SANDBOX_NAME_PATTERN.test(trimmed)) {
    return '沙箱名只能包含小写字母、数字、连字符与下划线，且必须以字母或数字开头，长度不超过 24 个字符';
  }
  return null;
}

/** 校验镜像选择，返回错误文案；合法时返回 `null`。 */
export function validateImageSelection(image: string): string | null {
  if (image.trim().length === 0) {
    return '请选择沙箱镜像';
  }
  return null;
}
