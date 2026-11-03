import { readFile } from 'node:fs/promises';
import { existingRegistration } from './registration.js';
try {
  const file = process.argv[2]; if (!file) throw new Error();
  console.log(JSON.stringify(existingRegistration(JSON.parse(await readFile(file, 'utf8'))), null, 2));
} catch { console.error('Supply an operator JSON file with actual container ID or Compose project, name, version and runtime. No applications were inspected or modified.'); process.exitCode = 1; }
