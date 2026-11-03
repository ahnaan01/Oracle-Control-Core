export function parseRecognizedCommand(text: string, names: ReadonlySet<string>, addressedTo?: string) {
  if (text.length > 512) return null;
  const match = /^\/([a-z][a-z0-9_]*)(?:@([a-z0-9_]+))?(?:\s+(.*))?$/is.exec(text);
  if (!match || (match[2] && (!addressedTo || match[2].toLowerCase() !== addressedTo.toLowerCase()))) return null;
  const name = match[1]!.toLowerCase();
  return names.has(name) ? { name, args: match[3]?.trim().split(/\s+/).filter(Boolean) ?? [] } : null;
}
