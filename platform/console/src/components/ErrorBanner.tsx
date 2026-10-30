/**
 * 错误提示条。文案直接用后端返回的 `detail`，不另造说法。
 */
export function ErrorBanner({ message, testId }: { message: string; testId: string }) {
  if (!message) {
    return null;
  }
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive-soft px-3 py-2 text-[12.5px] text-destructive"
      data-testid={testId}
    >
      {message}
    </div>
  );
}
