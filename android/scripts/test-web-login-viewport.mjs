import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

// Run in a container with Node and Chromium. Every fixture is local and requires no account.
const chromium = process.env.CHROMIUM_PATH || 'chromium';
const source = process.env.AA_WEBVIEW_SCRIPT || fileURLToPath(
  new URL('../app/src/main/assets/web-login-viewport.js', import.meta.url),
);
let script;
try {
  execFileSync(chromium, ['--version'], { stdio: 'pipe' });
  script = readFileSync(source, 'utf8');
  new Script(script, { filename: source });
} catch (error) {
  console.error(JSON.stringify({ doctor: 'failed', chromium, source, error: error.message }));
  process.exit(1);
}

const directory = mkdtempSync(join(tmpdir(), 'aa-web-login-'));
const property = '--agents-anywhere-android-viewport-height';
let failures = 0;
let count = 0;

function check(name, { body, setup = '', action = '', measure, delay = 1600 }, verify) {
  count += 1;
  const filename = join(directory, `${name}.html`);
  const html = `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body { margin: 0 }</style>
    <script>window.messages = []; console.log = (...args) => messages.push(args.join(' ')); ${setup}</script>
    <script>${script}</script>
    </head><body>${body}<pre id="result"></pre><script>
      ${action}
      setTimeout(() => {
        try {
          const value = (${measure})();
          document.querySelector('#result').textContent = JSON.stringify({ value });
        } catch (error) {
          document.querySelector('#result').textContent = JSON.stringify({ error: error.message });
        }
      }, ${delay});
    </script></body></html>`;
  writeFileSync(filename, html);
  try {
    const dom = execFileSync(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
      '--dump-dom', '--window-size=500,800', `--virtual-time-budget=${delay + 400}`,
      `file://${filename}?oauth_pending=synthetic-secret&email=person%40example.test`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    const encoded = dom.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(encoded, 'Chromium did not produce a fixture result');
    const result = JSON.parse(encoded.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
    assert.equal(result.error, undefined);
    verify(result.value);
    console.log(JSON.stringify({ test: name, passed: true }));
  } catch (error) {
    failures += 1;
    console.error(JSON.stringify({ test: name, passed: false, error: error.message }));
  }
}

try {
  check('normal-page-keeps-header-form-footer', {
    body: '<div id="header" style="height:40px">Brand</div><div id="form" style="height:180px"><input></div><div id="footer" style="height:40px">Help</div>',
    measure: `() => ['header', 'form', 'footer'].map(id => document.getElementById(id).offsetHeight)`,
  }, value => assert.deepEqual(value, [40, 180, 40]));

  check('patternfly-background-fills-the-viewport', {
    body: '<div class="pf-c-background-image" style="height:0"></div><div id="empty"></div>',
    measure: '() => ({ background: document.querySelector(".pf-c-background-image").clientHeight, empty: document.querySelector("#empty").clientHeight, viewport: visualViewport.height })',
  }, value => {
    assert.ok(value.background >= Math.round(value.viewport), JSON.stringify(value));
    assert.equal(value.empty, 0);
  });

  check('normal-patternfly-card-keeps-content-height', {
    body: '<div class="pf-c-login"><div class="pf-c-login__container"><main class="pf-c-login__main" style="height:180px"><input></main><footer style="height:40px">Help</footer></div></div>',
    measure: `() => [document.querySelector('.pf-c-login__main').offsetHeight, document.querySelector('.pf-c-login__container').offsetHeight]`,
  }, value => assert.deepEqual(value, [180, 220]));

  for (const [name, body, selector] of [
    ['collapsed-root-recovers', '<div id="login" style="height:0;overflow:hidden"><form style="height:180px"><input></form></div>', '#login'],
    ['collapsed-patternfly-card-recovers', '<div class="pf-c-login"><main class="pf-c-login__main" style="height:0;overflow:hidden"><form style="height:180px"><input></form></main></div>', '.pf-c-login__main'],
  ]) {
    check(name, {
      body,
      measure: `() => ({ height: document.querySelector('${selector}').clientHeight, viewport: visualViewport.height })`,
    }, value => assert.ok(value.height >= Math.round(value.viewport), JSON.stringify(value)));
  }

  check('nested-percentage-login-recovers', {
    body: '<div id="login" style="height:0;overflow:hidden"><form style="height:100%;overflow:hidden"><input style="height:20px"></form></div>',
    measure: `() => ({
      height: document.querySelector('#login').clientHeight,
      form: document.querySelector('form').clientHeight,
      inputBottom: document.querySelector('input').getBoundingClientRect().bottom,
      formBottom: document.querySelector('form').getBoundingClientRect().bottom,
      viewport: visualViewport.height,
    })`,
  }, value => {
    assert.ok(value.height >= Math.round(value.viewport), JSON.stringify(value));
    assert.ok(value.form >= value.inputBottom && value.formBottom >= value.inputBottom, JSON.stringify(value));
  });

  check('empty-and-hidden-containers-stay-collapsed', {
    body: '<div id="empty"></div><div id="hidden" style="display:none"><form style="height:180px"><input></form></div>',
    measure: `() => ['empty', 'hidden'].map(id => document.getElementById(id).offsetHeight)`,
  }, value => assert.deepEqual(value, [0, 0]));

  check('nested-empty-and-hidden-controls-stay-collapsed', {
    body: '<div id="empty"><div></div></div><div id="hidden"><input type="hidden"></div>',
    measure: `() => ['empty', 'hidden'].map(id => document.getElementById(id).offsetHeight)`,
  }, value => assert.deepEqual(value, [0, 0]));

  check('unclipped-overlay-container-keeps-zero-height', {
    body: '<div id="overlay" style="height:0;overflow:visible"><div style="position:absolute;height:80px">Notice</div></div><div id="form" style="height:180px"><input></div>',
    measure: `() => ['overlay', 'form'].map(id => document.getElementById(id).offsetHeight)`,
  }, value => assert.deepEqual(value, [0, 180]));

  check('explicit-inline-min-height-is-preserved', {
    body: '<div id="collapsed" style="height:0;min-height:0!important;overflow:hidden"><form style="height:180px"><input></form></div>',
    measure: '() => document.querySelector("#collapsed").clientHeight',
  }, value => assert.equal(value, 0));

  check('closed-shadow-login-recovers', {
    body: '<div id="login" style="height:0;overflow:hidden"><login-card style="display:block;height:100%"></login-card></div>',
    action: `window.card = document.querySelector('login-card').attachShadow({ mode: 'closed' });
      card.innerHTML = '<form style="height:100%;margin:0;overflow:hidden"><input style="height:20px"></form>';`,
    measure: `() => ({
      height: document.querySelector('#login').clientHeight,
      form: card.querySelector('form').clientHeight,
      inputBottom: card.querySelector('input').getBoundingClientRect().bottom,
      viewport: visualViewport.height,
    })`,
  }, value => {
    assert.ok(value.height >= Math.round(value.viewport), JSON.stringify(value));
    assert.ok(value.form >= value.inputBottom, JSON.stringify(value));
  });

  check('viewport-utilities-and-resize-update', {
    setup: "Object.defineProperty(window, 'visualViewport', { value: Object.assign(new EventTarget(), { height: 600 }) });",
    body: '<section class="h-dvh" style="height:0"></section><section class="min-h-screen"></section>',
    action: "setTimeout(() => { visualViewport.height = 420; visualViewport.dispatchEvent(new Event('resize')); }, 100);",
    measure: `() => [document.querySelector('.h-dvh').clientHeight, document.querySelector('.min-h-screen').clientHeight, getComputedStyle(document.documentElement).getPropertyValue('${property}')]`,
  }, value => assert.deepEqual(value, [420, 420, '420px']));

  check('zero-viewport-retries-without-resize-events', {
    setup: `Object.defineProperty(window, 'visualViewport', { value: Object.assign(new EventTarget(), { height: 0 }) });
      Object.defineProperty(window, 'innerHeight', { value: 0 });
      Object.defineProperty(document.documentElement, 'clientHeight', { get: () => 0 });`,
    body: '<section class="h-dvh" style="height:0"></section>',
    action: `window.sample = [];
      setTimeout(() => { visualViewport.height = 500; }, 50);
      setTimeout(() => { sample.push(document.querySelector('.h-dvh').clientHeight); }, 350);
      setTimeout(() => { visualViewport.height = 450; }, 600);`,
    measure: '() => [...sample, document.querySelector(".h-dvh").clientHeight]',
  }, value => assert.deepEqual(value, [500, 450]));

  check('late-idp-content-recovers', {
    body: '<section id="mount"></section>',
    action: `setTimeout(() => {
      document.querySelector('#mount').outerHTML = '<div id="login" style="height:0;overflow:hidden"><form style="height:180px"><input></form></div>';
    }, 1400);`,
    measure: '() => ({ height: document.querySelector("#login").clientHeight, viewport: visualViewport.height })',
    delay: 2000,
  }, value => assert.ok(value.height >= Math.round(value.viewport), JSON.stringify(value)));

  check('existing-login-shown-after-samples-recovers', {
    body: '<div id="login" style="display:none;height:0;overflow:hidden"><form style="height:180px"><input></form></div>',
    action: 'setTimeout(() => { document.querySelector("#login").style.display = "block"; }, 1400);',
    measure: '() => ({ height: document.querySelector("#login").clientHeight, viewport: visualViewport.height })',
    delay: 2000,
  }, value => assert.ok(value.height >= Math.round(value.viewport), JSON.stringify(value)));

  check('subframes-keep-their-own-layout', {
    body: '<iframe id="frame"></iframe>',
    action: `document.querySelector('#frame').srcdoc = ${JSON.stringify(`<!doctype html><html><body><section class="h-dvh" style="height:20px"></section><script>${script}</script></body></html>`).replaceAll('</script>', '<\\/script>')};`,
    measure: `() => {
      const doc = document.querySelector('#frame').contentDocument;
      return [doc.querySelector('.h-dvh').clientHeight, doc.documentElement.style.getPropertyValue('${property}')];
    }`,
  }, value => assert.deepEqual(value, [20, '']));

  check('does-not-intercept-network-traffic', {
    setup: 'window.originalFetch = window.fetch; window.originalOpen = XMLHttpRequest.prototype.open;',
    body: '<div><input></div>',
    measure: '() => [window.fetch === originalFetch, XMLHttpRequest.prototype.open === originalOpen]',
  }, value => assert.deepEqual(value, [true, true]));

  check('does-not-log-login-url', {
    body: '<div><input></div>',
    measure: '() => messages',
  }, value => assert.deepEqual(value, []));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(JSON.stringify({ tests: count, failures }));
process.exitCode = failures ? 1 : 0;
