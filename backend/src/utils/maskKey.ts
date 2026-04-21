export function maskKey(key: string) {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
