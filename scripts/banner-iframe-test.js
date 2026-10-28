// Loads a local wrapper page that iframes the (login-protected) exec URL in a clean Chrome profile, and reports what the frame does.
const { chromium } = require('playwright-core');
const http = require('http');
const EXEC = process.argv[2];

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>wrapper</title><iframe id="app" src="' + EXEC + '" style="width:900px;height:600px"></iframe>');
}).listen(0, async () => {
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  const page = await browser.newPage();
  const events = [];
  page.on('console', (m) => events.push('console: ' + m.text().slice(0, 200)));
  page.on('response', (r) => { if (/google\.com|googleusercontent/.test(r.url())) events.push(r.status() + ' ' + r.url().slice(0, 110) + ' xfo=' + r.headers()['x-frame-options'] + ' csp=' + (r.headers()['content-security-policy'] || '').slice(0, 90)); });
  await page.goto('http://localhost:' + port + '/');
  await page.waitForTimeout(5000);
  console.log('frames:', page.frames().map((f) => f.url().slice(0, 110)));
  console.log(events.join('\n'));
  await browser.close();
  server.close();
});
