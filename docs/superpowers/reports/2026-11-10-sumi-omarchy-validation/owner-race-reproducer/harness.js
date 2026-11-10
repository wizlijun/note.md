/* Isolated real-host RPC regression. Never load beside the production UI module. */
(() => {
  'use strict';
  const key = `sumi-isolated-detach-mount-result-${Date.now()}`;
  const output = document.querySelector('#result');
  const report = { status: 'running', storageKey: key, started: new Date().toISOString(), rounds: [], limitation: 'Concurrent scheduling regression; no claim that every possible interleaving was forced.' };
  let live;
  const publish = () => {
    output.value = JSON.stringify(report, null, 2);
    localStorage.setItem(key, output.value);
    localStorage.setItem('sumi-isolated-detach-mount-latest', key);
    document.title = `Sumi detach/mount: ${report.status}`;
  };
  const same = (a, b) => a?.id === b?.id && a?.generation === b?.generation;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const request = (method, params) => window.notemd.request(`host.sumi.${method}`, params);
  const geometry = () => {
    const rect = document.querySelector('#surface').getBoundingClientRect();
    return { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewportWidth: innerWidth };
  };
  const mount = async pageId => {
    const result = await request('mount', { pageId, ...geometry() });
    assert(result && typeof result.id === 'string' && Number.isInteger(result.generation), `Unexpected mount reply: ${JSON.stringify(result)}`);
    return result;
  };
  document.addEventListener('keydown', event => {
    if (event.key !== 'F8') return;
    event.preventDefault(); output.focus(); output.select();
  });
  const run = async () => {
    assert(document.body.dataset.isolatedSumiRegression === '1', 'Missing isolated harness marker');
    assert(window.notemd?.pluginId === 'notemd.sumi', 'Requires the real Sumi plugin bridge');
    const state = await request('state');
    assert(state.available && state.activePageId, 'Requires an existing isolated writing page');
    report.pageId = state.activePageId;
    report.environment = { href: location.href, width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
    report.initialSaveState = state.saveState;
    live = await mount(report.pageId);
    report.initialSurface = live;
    publish();
    for (let round = 0; round < 16; round++) {
      const old = live;
      const entry = { round, old, launchGapMs: [0, 1, 5, 10][round % 4], started: performance.now() };
      report.rounds.push(entry); publish();
      // Both requests are outstanding together; all work reaches the production
      // dispatcher and GTK. No mocked mutex, ownership or native callbacks.
      const dropping = request('detach', { surface: old });
      await delay(entry.launchGapMs);
      const mounting = mount(report.pageId);
      const [detached, mounted] = await Promise.allSettled([dropping, mounting]);
      entry.detach = detached.status === 'fulfilled' ? 'ok' : String(detached.reason);
      entry.concurrentMount = mounted.status === 'fulfilled' ? mounted.value : { error: String(mounted.reason) };
      assert(detached.status === 'fulfilled', `Round ${round}: detach failed`);
      assert(mounted.status === 'fulfilled', `Round ${round}: concurrent mount failed`);
      const candidate = mounted.value;
      if (same(candidate, old)) {
        // Mount may legitimately acquire lifecycle first and return A; detach
        // then removes A. This ordering cannot test survival of a new B.
        entry.order = 'mount-reused-A-before-detach';
        live = await mount(report.pageId);
      } else {
        entry.order = 'new-B-returned';
        live = candidate;
      }
      entry.current = live;
      await request('bounds', { surface: live, ...geometry() });
      await request('visible', { surface: live, visible: true });
      await request('focus', { surface: live });
      entry.currentCapabilityAlive = true;
      const rebound = await mount(report.pageId);
      entry.followupMount = rebound;
      assert(same(rebound, live), `Round ${round}: owner lost; followup mount produced another surface`);
      entry.reusedCurrent = true;
      entry.elapsedMs = performance.now() - entry.started;
      publish();
    }
    report.newBSurvivalRounds = report.rounds.filter(round => round.order === 'new-B-returned' && round.currentCapabilityAlive && round.reusedCurrent).length;
    assert(report.newBSurvivalRounds > 0, 'No new-B ordering observed; result is inconclusive');
    const after = await request('state');
    assert(after.activePageId === report.pageId, 'Active page changed during regression');
    report.finalSurface = live;
    report.finalSaveState = after.saveState;
    report.status = 'passed';
  };
  publish();
  run().catch(error => { report.status = 'failed'; report.error = String(error?.stack || error); })
    .finally(async () => {
      if (live) {
        try { await request('visible', { surface: live, visible: false }); report.surfaceHiddenForReport = true; }
        catch (error) { report.cleanupError = String(error); report.status = 'failed'; }
      }
      report.finished = new Date().toISOString(); publish(); output.focus(); output.select();
    });
})();
