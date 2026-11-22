// Renderer script for run-update-test.mjs: the forced update window must lock the app,
// show "1.0.0 → 1.0.1" with the release notes, download with progress and hand off to the installer.
(async () => {
  const T = window.lunarixTest;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const waitFor = async (fn, ms = 15000, what = '') => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    throw new Error('timeout waiting for ' + what);
  };
  let installed = null;
  window.lunarix.on('update:test-installed', (p) => (installed = p));
  try {
    const gate = await waitFor(() => $('.update-gate'), 20000, 'update window');
    await sleep(700);
    const text = gate.textContent;
    for (const s of ['v1.0.0', 'v1.0.1', 'Plan zadań sam się odhacza']) if (!text.includes(s)) throw new Error('update window is missing: ' + s);
    await T.capture('u1-update-required');
    await T.log('gate OK: ' + text.slice(0, 160).replace(/\s+/g, ' '));

    // the app behind it must not react to the keyboard (Ctrl+, opens settings normally)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    if (!$('.update-gate')) throw new Error('update window disappeared after key presses');

    const btn = [...gate.querySelectorAll('.btn.primary')][0];
    if (!btn) throw new Error('no update button');
    btn.click();
    await waitFor(() => $('.ug-progress .ug-bar i') && parseInt($('.ug-progress .ug-bar i').style.width) > 15, 15000, 'download progress');
    await T.capture('u2-downloading');
    await waitFor(() => installed, 30000, 'installer hand-off');
    await sleep(300);
    await T.capture('u3-installing');
    const st = await window.__lx.api.updateState();
    if (st.state !== 'installing') throw new Error('state after download: ' + st.state);
    if (!installed.args.includes('/S') || !installed.args.some((a) => a.startsWith('/D='))) throw new Error('installer args: ' + installed.args.join(' '));
    await T.log('download+handoff OK: ' + installed.size + ' bytes, args ' + installed.args.join(' '));
    await T.log('ALL OK');
  } catch (e) {
    await T.log('TEST ERROR: ' + (e && e.stack ? e.stack : e));
    try {
      await T.capture('u9-error');
    } catch {}
  }
  await sleep(300);
  await T.quit();
})();
