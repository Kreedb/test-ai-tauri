// Serves the built site under the GitHub Pages repository prefix and checks the
// Web preview without a Tauri mock. Run `npm run build` first.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../dist', import.meta.url));
const prefix = '/test-ai-tauri/';
const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

await readFile(join(root, 'index.html')).catch(() => {
  throw new Error('dist/index.html is missing; run `npm run build` first');
});

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  const relative = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
  const file = join(root, normalize(relative));
  if (!pathname.startsWith(prefix) || !file.startsWith(root + sep)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}${prefix}`;

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
  assert(failures.length === 0, failures.join('\n'));
  console.log(`Web preview OK at ${base}`);
} finally {
  await browser.close();
  server.close();
}
