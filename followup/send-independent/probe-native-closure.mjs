import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const repo = '/Users/reviewer/.codex/worktrees/review-message-send/latch';
const dir = '/tmp/latch-review-20260927/send-independent';
const require = createRequire(`${repo}/package.json`);
const esbuild = require('esbuild');
const sourceFile = `${repo}/packages/device-core/src/whatsappSend.ts`;
const testsFile = `${repo}/packages/device-core/test/whatsappSend.test.ts`;
const source = fs.readFileSync(sourceFile, 'utf8');
const tests = fs.readFileSync(testsFile, 'utf8');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const bundleFile = `${dir}/fixed/whatsappSend.mjs`;
await esbuild.build({ entryPoints: [sourceFile], bundle: true, format: 'esm', platform: 'node', outfile: bundleFile });
const { WHATSAPP_SCRIPT } = await import(pathToFileURL(bundleFile));

const controllerFixture = tests.slice(tests.indexOf('const PHONE'), tests.indexOf('describe("fixed WhatsApp send controller"'))
  .replace('return { state, run:', 'return { adapter, state, run:');
const nativeFixture = tests.slice(tests.indexOf('function nativeAxFixture()'), tests.indexOf('describe("native AX adapter"'));
const clipboardFixture = tests.slice(tests.indexOf('class PasteboardItem'), tests.indexOf('describe("native clipboard lease"'));
const context = { WHATSAPP_SCRIPT, vm, Buffer };
const helper = await esbuild.transform(`${controllerFixture}\n${nativeFixture}\n${clipboardFixture}\nglobalThis.helpers = { fixture, nativeAxFixture, clipboardFixture, PasteboardItem };`, {loader: 'ts', format: 'iife'});
vm.runInNewContext(helper.code, context);
const { fixture, nativeAxFixture, clipboardFixture: clipboard, PasteboardItem } = context.helpers;
const cases = {};
function observe(name, configure, expected, count) {
  const f = fixture();
  configure?.(f);
  let outcome;
  try { outcome = f.run(); } catch (error) { outcome = error.message; }
  const sendCount = f.state.actions.filter(x => x === 'send').length;
  assert.equal(outcome, expected, name);
  assert.equal(sendCount, count, name);
  cases[name] = { outcome, sendCount, elapsedFixtureMs: f.state.now, actions: Array.from(f.state.actions) };
  return f;
}

observe('happyPathOnce', null, 'LATCH_SEND_ATTEMPTED', 1);
for (const field of ['heading', 'headerRef', 'composerRef']) {
  observe(`changed_${field}_afterFinalInfoClose`, f => {
    f.state.onEscape = () => {
      if (f.state.escaped === 2) {
        f.state[field] = 'another conversation';
        f.state.phone = '+1 555 999 9999';
      }
    };
  }, 'LATCH_RECIPIENT_UNVERIFIED', 0);
}
for (const field of ['headerRole', 'composerRole', 'sendRole']) {
  observe(`unexpected_${field}`, f => { f.state[field] = 'AXStaticText'; },
    field === 'sendRole' ? 'LATCH_COMPOSER_UNVERIFIED' : 'LATCH_RECIPIENT_UNVERIFIED', 0);
}
for (const [status, expected] of [[-25205, 'AX attribute unsupported'], [-25202, 'LATCH_AX_TRANSIENT:-25202'], [-25204, 'LATCH_AX_TRANSIENT:-25204'], [-25201, 'AX read failed:-25201'], [-25212, '']]) {
  const f = nativeAxFixture();
  f.state.valueError = status;
  let outcome;
  try { outcome = f.adapter.snapshot().roots[0].children[0].value; } catch (error) { outcome = error.message; }
  assert.equal(outcome, expected);
  cases[`nativeComposerAXValue_${status}`] = { outcome };
}
observe('pressThrowsAfterAction', f => { f.state.sendThrows = true; }, 'LATCH_SEND_UNVERIFIED', 1);
observe('clipboardRestoreThrowsAfterAction', f => {
  const original = f.adapter.clipboard;
  f.adapter.clipboard = (...args) => ({ ...original(...args), restore() { throw new Error('restore failed'); } });
}, 'LATCH_SEND_UNVERIFIED', 1);
observe('pasteFocusChangesBeforePaste', f => { f.state.onFocus = () => { f.state.focusedRef = 'other field'; }; }, 'LATCH_COMPOSER_UNVERIFIED', 0);
observe('laterUserClipboardBeforePaste', f => { f.state.onClipboard = () => { f.state.clipboardRevision++; }; }, 'LATCH_COMPOSER_UNVERIFIED', 0);

{
  const f = observe('transientReadRecoveryAfterEachClose', f => {
    f.state.onEscape = () => { f.state.snapshotErrors.push('LATCH_AX_TRANSIENT:-25202', 'LATCH_AX_TRANSIENT:-25204'); };
  }, 'LATCH_SEND_ATTEMPTED', 1);
  assert.equal(f.state.now, 600);
  assert.equal(f.state.actions.filter(x => x === 'info').length, 2);
  assert.equal(f.state.actions.filter(x => x === 'escape').length, 2);
  assert.equal(f.state.actions.filter(x => x === 'paste').length, 1);
}
{
  const f = observe('persistentTransientReadsReachDeadline', f => {
    f.state.snapshotErrors = Array(250).fill('LATCH_AX_TRANSIENT:-25204');
  }, 'LATCH_RECIPIENT_UNVERIFIED', 0);
  assert.ok(f.state.now >= 30_000 && f.state.now <= 30_150);
}
{
  const f = observe('unsupportedReadDoesNotRetry', f => {
    f.state.snapshotErrors = ['AX attribute unsupported'];
  }, 'LATCH_RECIPIENT_UNVERIFIED', 0);
  assert.equal(f.state.now, 0);
}
{
  const f = observe('unknownTransientStatusDoesNotRetry', f => {
    f.state.snapshotErrors = ['LATCH_AX_TRANSIENT:-25201'];
  }, 'LATCH_RECIPIENT_UNVERIFIED', 0);
  assert.equal(f.state.now, 0);
}
observe('conversationSwitchDuringTransientReadStillRefuses', f => {
  f.state.onEscape = () => {
    if (f.state.escaped === 2) {
      f.state.snapshotErrors.push('LATCH_AX_TRANSIENT:-25202');
      f.state.heading = 'different contact';
      f.state.phone = '+1 555 999 9999';
    }
  };
}, 'LATCH_RECIPIENT_UNVERIFIED', 0);
for (const action of ['info', 'send']) {
  const f = observe(`transientMarkerFrom_${action}_actionIsNeverRetried`, f => {
    const press = f.adapter.press;
    f.adapter.press = target => {
      press(target);
      if ((action === 'info' && target.identifier === 'NavigationBar_HeaderViewButton') ||
          (action === 'send' && target.identifier === 'ChatBar_SendButton')) {
        throw new Error('LATCH_AX_TRANSIENT:-25204');
      }
    };
  }, action === 'info' ? 'LATCH_RECIPIENT_UNVERIFIED' : 'LATCH_SEND_UNVERIFIED', action === 'info' ? 0 : 1);
  assert.equal(f.state.actions.filter(x => x === action).length, 1);
  assert.equal(f.state.now, 0);
}

const data = items => JSON.stringify(items.map(item => [...item.data]));
{
  const f = clipboard();
  const expected = data(f.original);
  const lease = f.prepare('approved message');
  assert.equal(lease.current(), true);
  lease.restore();
  assert.equal(data(f.board.items), expected);
  cases.clipboardRestoresAllItemsAndBinaryTypes = { pass: true, items: f.board.items.length, types: f.board.items.flatMap(x => [...x.data.keys()]) };
}
{
  const f = clipboard();
  const lease = f.prepare('approved message');
  const later = new PasteboardItem();
  later.setStringForType('later user copy', 'public.utf8-plain-text');
  f.board.writeObjects([later]);
  lease.restore();
  assert.equal(f.board.items[0], later);
  cases.clipboardPreservesLaterUserCopy = { pass: true };
}
for (const when of ['before', 'after']) {
  const f = clipboard();
  const expected = data(f.original);
  const write = f.board.writeObjects.bind(f.board);
  let first = true;
  f.board.writeObjects = items => {
    if (!first) return write(items);
    first = false;
    if (when === 'after') write(items);
    throw new Error('write error');
  };
  let outcome;
  try { f.prepare('approved message'); } catch (error) { outcome = error.message; }
  assert.equal(outcome, 'clipboard write failed');
  assert.equal(data(f.board.items), expected);
  cases[`clipboardWriteThrows_${when}`] = { outcome, originalsRestored: true };
}
assert.equal(fs.readFileSync(sourceFile, 'utf8'), source, 'source changed during probe');
assert.equal(fs.readFileSync(testsFile, 'utf8'), tests, 'fixtures changed during probe');
const result = { timestamp: new Date().toISOString(), scope: 'Production fixed script in VM; fixture adapters only, no native UI or sends', sourceSHA256: hash(source), fixtureSHA256: hash(tests), caseCount: Object.keys(cases).length, cases };
fs.writeFileSync(`${dir}/native-closure-results.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({caseCount: result.caseCount, sourceSHA256: result.sourceSHA256, allPassed: true}));
