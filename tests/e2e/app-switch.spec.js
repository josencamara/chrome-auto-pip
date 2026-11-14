const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '../../background/app-switch.js'), 'utf8');
const command = 'open-pip-after-app-switch';

async function setup({ cold = false } = {}) {
  const tab = { id: 11, windowId: 3, active: true, url: 'https://video.example/' };
  const window = { id: 3, type: 'normal', focused: false };
  const handlers = {};
  const calls = [];
  const event = name => ({ addListener(listener) { handlers[name] = listener; } });
  const state = { autoPipOnTabSwitch: true, allowed: true };
  const chrome = {
    commands: { onCommand: event('command') },
    windows: {
      get: async () => window,
      WINDOW_ID_NONE: -1,
      onFocusChanged: event('focus'), onRemoved: event('windowRemoved')
    },
    tabs: {
      query(_options, callback) {
        if (callback) return queueMicrotask(() => callback([tab]));
        return cold ? new Promise(() => {}) : Promise.resolve([tab]);
      },
      onActivated: event('activated'),
      onUpdated: event('updated'), onRemoved: event('removed')
    },
    runtime: {},
    scripting: {
      executeScript: async request => {
        calls.push(request);
        return [{ result: { opened: true } }];
      }
    }
  };
  const AutoPip = {
    state,
    debug: { debugLog() {} },
    urlRules: { isValidTab: () => true, isAutoPipAllowedTab: () => state.allowed }
  };
  vm.runInNewContext(source, { chrome, AutoPip });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  return { tab, window, handlers, calls, state, settle };
}

test('global command opens on the cached selected tab and closes on browser return', async () => {
  const { handlers, window, calls, tab, settle } = await setup();
  handlers.command(command);
  expect(calls[0].target.tabId).toBe(tab.id);
  expect(calls[0].args[0]).toBe(tab.url);
  await settle();
  window.focused = true;
  handlers.focus(window.id);
  await settle();
  expect(calls).toHaveLength(2);
  expect(calls[1].target.tabId).toBe(tab.id);
  expect(calls[1].args).toEqual([calls[0].args[1]]);
});

test('a command waking the worker resolves the selected tab without a command tab', async () => {
  const { tab, handlers, calls, settle } = await setup({ cold: true });
  handlers.command(command);
  await settle();
  expect(calls).toHaveLength(1);
  expect(calls[0].target.tabId).toBe(tab.id);
});

test('global command skips disabled or blocked sites', async () => {
  const { handlers, calls, state } = await setup();
  state.allowed = false;
  handlers.command(command);
  state.allowed = true;
  state.autoPipOnTabSwitch = false;
  handlers.command(command);
  expect(calls).toHaveLength(0);
});
