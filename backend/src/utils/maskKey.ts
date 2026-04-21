export function maskKey(key: string) {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "***";
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${head}…${tail}`;
}
