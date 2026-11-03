import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createApp } from '../src/api/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security/crypto.js';

// Optional local-browser check. No production credentials or external requests.
const executablePath = process.env.OCC_CHROMIUM_PATH ?? '/usr/bin/chromium';
for (const basePath of ['/sys', '/control/occ']) {
  const core = await createApp(loadConfig({ OCC_DB_PATH: ':memory:', OCC_BASE_PATH: basePath }));
  const password = 'disposable-browser-test-password';
  core.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('browser-admin', 'browser-admin', await hashPassword(password), '["admin"]');
  const address = await core.app.listen({ host: '127.0.0.1', port: 0 });
  // The runtime origin is fixed before requests; use the selected local ephemeral listener.
  core.config.OCC_PUBLIC_ORIGIN = address;
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
  try {
    const page = await browser.newPage(); const failures: string[] = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && message.text().includes('Content Security Policy')) failures.push(message.text()); });
    await page.route('**/*', route => new URL(route.request().url()).origin === address ? route.continue() : route.abort());
    await page.goto(`${address}${basePath}/monitoring`);
    await page.getByLabel('Username', { exact: true }).fill('browser-admin');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Enter dashboard' }).click();
    await page.getByRole('heading', { name: 'Monitoring', exact: true }).waitFor();
    await page.getByText('Runtime details', { exact: true }).waitFor();
    await page.getByText('OCC process RSS:', { exact: false }).waitFor();
    await page.route('**/api/v1/system', route => route.abort());
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await page.unroute('**/api/v1/system');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'hidden' });
    if (basePath === '/sys') await page.screenshot({ path: '/tmp/occ-dashboard.png', fullPage: true });
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    const manifest = { protocolVersion: '1.0', id: 'browser-app', name: 'Browser app', version: '1', runtime: 'external' };
    await page.getByLabel('Project manifest (JSON)').fill(JSON.stringify(basePath === '/sys' ? { manifest, metadata: { containerId: 'abcdef123456' } } : manifest));
    await page.getByRole('button', { name: 'Register project', exact: true }).click();
    await page.getByText('Browser app', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('Browser app', { exact: true }).waitFor();
    for (const name of ['Overview', 'Monitoring', 'Bots', 'Containers', 'Activity', 'Settings']) {
      await page.getByRole('link', { name, exact: true }).click();
      await page.getByRole('heading', { name, exact: true }).waitFor();
    }
    await page.getByLabel('Refresh interval').selectOption('30');
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await page.getByText('Refresh interval saved.', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Enter dashboard' }).waitFor();
    assert.deepEqual(failures, []);
    console.log(`PASS browser: ${basePath} login, nested route/assets, registration, navigation, settings/CSRF, mobile layout, logout`);
  } finally { await browser.close(); await core.app.close(); }
}
