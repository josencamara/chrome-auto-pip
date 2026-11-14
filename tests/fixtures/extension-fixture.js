const { test: base, expect } = require('@playwright/test');
const { launchLocalContext, waitForExtensionWorker } = require('../../scripts/local-test/local-session');

const test = base.extend({
  context: async ({}, use) => {
    let session = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        session = await launchLocalContext({ artifactPrefix: 'playwright' });
        break;
      } catch (error) {
        if (attempt >= 2 || error.code !== 'AUTO_PIP_WORKER_STARTUP') throw error;
      }
    }
    if (session.skipped) throw new Error(session.skipReason);

    try {
      await use(session.context);
    } finally {
      if (session) await session.close();
    }
  },
  extensionId: async ({ context }, use) => {
    const worker = context.__autoPipExtensionWorker || await waitForExtensionWorker(context);
    const extensionId = worker.url().split('/')[2];
    await use(extensionId);
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
  }
});

module.exports = { test, expect };
