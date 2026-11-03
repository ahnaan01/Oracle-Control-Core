import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { OccClient, manifestSchema } from '../../packages/integration-sdk/src/index.js';

// Optional: connect to an OCC instance you explicitly provisioned. Never run against production during development.
const url = z.url().parse(process.env.OCC_SAMPLE_API_URL);
const token = z.string().min(32).parse(process.env.OCC_SAMPLE_TOKEN);
const sdk = new OccClient(url, token);
const manifest = manifestSchema.parse(JSON.parse(await readFile('examples/sample-integration/manifest.json', 'utf8')));
await sdk.register(manifest);
await sdk.reportHealth('healthy');
await sdk.publish('sample-app.ready', { status: 'ready' }, randomUUID());
console.log('Sample integration registered and reported status.');
