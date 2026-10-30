/** 错误提示条。文案直接用后端返回的 `detail`，不另造说法。 */
export function ErrorBanner({ message, testId }: { message: string; testId: string }) {
  if (!message) {
    return null;
  }
  return (
    <div className="banner banner-error" role="alert" data-testid={testId}>
      {message}
    </div>
  );
}
