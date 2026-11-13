// Serves the built site under the GitHub Pages repository prefix and checks the
// Web preview without a Tauri mock. Run `npm run build` first.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const prefix = '/test-ai-tauri/';

await readFile(join(root, 'dist', 'index.html')).catch(() => {
  throw new Error('dist/index.html is missing; run `npm run build` first');
});

// `appType: 'mpa'` keeps missing assets as 404s instead of the SPA fallback.
const server = await preview({
  root,
  base: prefix,
  appType: 'mpa',
  logLevel: 'error',
  preview: { host: '127.0.0.1', port: 0 },
});
const base = server.resolvedUrls.local[0];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const failures = [];
  page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
  page.on('requestfailed', (request) => failures.push(`request failed: ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByText('Web 预览', { exact: true }).waitFor();

  // Web detection must disable every connection control and keep the hint visible.
  assert(await page.getByRole('button', { name: '连接 SSH' }).isDisabled(), 'connect button is enabled');
  for (const label of ['主机', '端口', '用户名', '密码']) {
    assert(await page.getByLabel(label, { exact: true }).isDisabled(), `${label} input is enabled`);
  }
  assert(
    await page.getByRole('note').isVisible(),
    'Web preview notice is hidden',
  );

  await page.waitForFunction(() =>
    document.querySelector('.xterm-rows')?.textContent?.includes('Tauri SSH Terminal'),
  );

  // A missing stylesheet still renders the markup, so check the shipped colors too.
  const background = await page.evaluate(
    () => getComputedStyle(document.documentElement).backgroundColor,
  );
  assert(background === 'rgb(11, 16, 24)', `stylesheet did not load (background ${background})`);

  await page.getByRole('button', { name: '工作区设置' }).click();
  await page.getByLabel('界面主题').selectOption('light');
  await page.getByLabel('字号（px）').fill('18');
  await page.getByRole('button', { name: '应用设置' }).click();
  await page.reload({ waitUntil: 'networkidle' });
  assert(await page.getByRole('button', { name: '连接 SSH' }).isDisabled(), 'settings enabled Web SSH');
  assert(await page.evaluate(() => document.documentElement.dataset.theme) === 'light', 'theme did not persist');
  await page.setViewportSize({ width: 360, height: 800 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile workspace overflows');
  await page.getByRole('button', { name: '工作区设置' }).click();
  assert(await page.getByLabel('字号（px）').inputValue() === '18', 'terminal settings did not persist');
  assert(await page.getByRole('button', { name: '应用设置' }).isVisible(), 'mobile settings actions are hidden');
  assert(failures.length === 0, failures.join('\n'));
  console.log(`Web preview OK at ${base}`);
} finally {
  await browser.close();
  await server.close();
}
