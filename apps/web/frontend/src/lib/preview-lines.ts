/**
 * Split preview text into the line representation shared by the UI and the
 * syntax-highlighting worker.
 *
 * CRLF is normalized by removing the line-ending `\r`; a trailing newline does
 * not create an extra line, while empty lines in the body remain significant.
 */
export function splitPreviewLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (normalized === '') {
    return [''];
  }
  return normalized.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}
