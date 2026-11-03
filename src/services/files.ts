import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { forbidden } from '../core/errors.js';
/** Future tools must call this on existing targets. No file mutation endpoint exists. */
export async function resolveProjectPath(root: string, target: string) {
  if (path.isAbsolute(target) || target.includes('\0')) throw forbidden();
  const base = await realpath(root); const resolved = await realpath(path.resolve(base, target));
  const relative = path.relative(base, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw forbidden();
  return resolved;
}
