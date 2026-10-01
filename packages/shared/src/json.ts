/** PostgreSQL JSONB cannot represent NUL or unpaired UTF-16 surrogates.
 * Replace them in display data, including diagnostic object keys, before storage.
 * Literal backslash sequences such as "\\u0000" remain unchanged.
 */
export function jsonForStorage(value: unknown): string {
  const text = (value: string) => value.toWellFormed().replaceAll('\0', '\uFFFD');
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'string') return text(item);
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const entries = Object.entries(item);
      if (entries.some(([key]) => text(key) !== key)) return Object.fromEntries(entries.map(([key, value]) => [text(key), value]));
    }
    return item;
  });
}
