// Scripted UI walkthrough executed inside the renderer (LUNARIX_TEST_SCRIPT).
(async () => {
  const T = window.lunarixTest;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const byText = (sel, ...txts) => $$(sel).find((e) => txts.some((t) => e.textContent.includes(t)));
  const click = (el, what) => {
    if (!el) throw new Error('element not found: ' + what);
    el.click();
  };
  const waitFor = async (fn, ms = 15000, what = '') => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(120);
    }
    throw new Error('timeout waiting for ' + what);
  };
  const shot = async (n, delay = 450) => {
    await sleep(delay);
    await T.capture(n);
    await T.log('shot ' + n);
  };
  const setInput = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const lx = () => window.__lx;
  try {
    await waitFor(() => $('.onboarding') || $('.app'), 20000, 'app');
    if ($('.onboarding')) {
      await shot('01-onboarding-welcome', 900);
      const startBtn = byText('button', 'Zaczynamy', "Let's start");
      if (startBtn) startBtn.click();
      else await T.log('NOTE: welcome step was not visible');
      await shot('02-onboarding-usecases', 800);
      click(byText('.choice', 'Gry', 'Games'), 'games');
      click(byText('.ob-foot button', 'Dalej', 'Next'), 'next1');
      await waitFor(() => $('.rec-card'), 40000, 'hardware recommendation');
      await shot('03-onboarding-hardware', 1200);
      click(byText('.ob-foot button', 'Dalej', 'Next'), 'next2');
      await shot('04-onboarding-keys', 700);
      click(byText('.ob-foot button', 'Pomiń', 'Skip'), 'skip');
      await sleep(500);
      const cb = $('.ob-step input[type=checkbox]');
      if (cb && cb.checked) cb.click();
      await shot('05-onboarding-download', 500);
      click(byText('.ob-foot button', 'Dalej', 'Next'), 'next4');
      await shot('06-onboarding-autonomy', 700);
      click(byText('.ob-foot button', 'Dalej', 'Next'), 'next5');
      await shot('07-onboarding-done', 700);
      click(byText('button', 'Otwórz Lunarix', 'Open Lunarix'), 'open');
    }
    await waitFor(() => $('.app') && lx(), 20000, 'main app');
    await shot('08-main-empty', 1600);

    // switch to the scripted mock model and run an agent task
    await lx().useApp.getState().patchSettings({ activeModel: { provider: 'mock', model: 'mock' } });
    await lx().useApp.getState().refreshModels();
    await sleep(300);
    const ta = await waitFor(() => $('.composer textarea'), 5000, 'composer');
    setInput(ta, 'Siemka, zrób mi prostą stronę powitalną w HTML');
    await sleep(250);
    await shot('09-composer-typed', 200);
    click($('.composer .send'), 'send');
    await sleep(1800);
    await shot('10-agent-running', 100);
    await waitFor(() => !lx().useApp.getState().chatMetas.some((c) => c.running), 90000, 'agent done');
    await shot('11-agent-done', 1200);
    // the mock never ticks its last plan item: Lunarix must tick it and hide the finished plan
    {
      const id = lx().useApp.getState().activeChatId;
      const todos = lx().useApp.getState().todos[id] || [];
      if (!todos.length || todos.some((t) => t.status !== 'completed')) throw new Error('plan not completed after the task: ' + JSON.stringify(todos));
      await waitFor(() => !$('.todo-card'), 6000, 'finished plan to disappear');
      await T.log('PLAN OK: auto-completed and hidden');
    }

    // approval flow ("ask" autonomy)
    const s1 = lx().useApp.getState().settings;
    await lx().useApp.getState().patchSettings({ agent: { ...s1.agent, approval: 'ask' } });
    await lx().useApp.getState().newChat();
    await sleep(400);
    setInput($('.composer textarea'), 'Zrób drugą stronę');
    await sleep(150);
    click($('.composer .send'), 'send2');
    const firstCard = await waitFor(() => $('.approval'), 30000, 'approval card');
    await shot('11b-approval', 500);
    click(byText('.approval button', 'Zezwól', 'Allow'), 'allow');
    // wait for the NEXT tool's approval card (the first one may still be in the DOM for a moment)
    await waitFor(() => {
      const c = $('.approval');
      return c && c !== firstCard && c.isConnected ? c : null;
    }, 30000, 'second approval');
    await sleep(150);
    click(byText('.approval button', 'Zawsze', 'Always'), 'always');
    await waitFor(() => !lx().useApp.getState().chatMetas.some((c) => c.running), 90000, 'agent 2 done');
    await shot('11c-after-approval', 800);
    await lx().useApp.getState().patchSettings({ agent: { ...lx().useApp.getState().settings.agent, approval: 'chill' } });

    // explorer + editor
    const row = await waitFor(() => byText('.tree-row', 'index.html'), 8000, 'index.html in tree');
    row.click();
    await shot('12-editor-file', 1500);

    // preview of the html
    const prevBtn = byText('.editor-toolbar button', 'Podgląd', 'Preview');
    if (prevBtn) {
      prevBtn.click();
      await shot('13-preview', 2200);
    }

    // terminal panel
    await lx().useApp.getState().patchUi({ panelVisible: true });
    await shot('14-terminal', 2500);
    await lx().useApp.getState().patchUi({ panelVisible: false });

    // settings pages
    lx().useApp.getState().setModal('settings', 'providers');
    await shot('15-settings-providers', 900);
    lx().useApp.setState({ settingsTab: 'local' });
    await shot('16-settings-local', 1500);
    lx().useApp.setState({ settingsTab: 'agent' });
    await shot('17-settings-agent', 700);
    lx().useApp.getState().setModal(null);

    // usage
    lx().useApp.getState().setModal('usage');
    await shot('18-usage', 900);
    lx().useApp.getState().setModal(null);

    // command palette
    lx().useApp.getState().setModal('palette');
    await shot('19-palette', 600);
    lx().useApp.getState().setModal(null);

    // chill mode
    lx().useApp.setState({ chill: true });
    await shot('20-chill', 1500);
    lx().useApp.setState({ chill: false });

    // model picker
    click($('.composer .c-bar .chip-btn:nth-child(2)'), 'model chip');
    await shot('21-model-picker', 900);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await sleep(300);

    // light theme
    await lx().useApp.getState().patchSettings({ theme: 'light' });
    await shot('22-light-theme', 1200);
    await lx().useApp.getState().patchSettings({ theme: 'dark' });

    // model advisor + measured speeds (no real download: a fake "downloaded" Medium is created)
    {
      const api = lx().api;
      const app = lx().useApp;
      let hw = await api.hardware(true);
      await T.log(`hardware: recommended=${hw.recommended} high=${JSON.stringify(hw.ratings.high)} medium=${JSON.stringify(hw.ratings.medium)}`);
      const s = app.getState().settings;
      // as if the engine had measured High at 4.6 tok/s over 5 replies on this PC
      await app.getState().patchSettings({ local: { ...s.local, measured: { high: { tps: 4.6, samples: 5, at: Date.now(), hw: hw.fingerprint } } } });
      hw = await api.hardware();
      app.setState({ hardware: hw });
      if (!hw.ratings.high.measured || !/zmierzone|measured/.test(hw.ratings.high.speed)) throw new Error('measured speed not used: ' + JSON.stringify(hw.ratings.high));
      await T.log(`measured rating OK: ${hw.ratings.high.speed} (${hw.ratings.high.rating}), recommended=${hw.recommended}`);
      // a chat on the slow tier shows the advisor above the composer
      const c = await app.getState().newChat();
      await api.setChatModel(c.id, { provider: 'local', model: 'high' });
      const adv = await waitFor(() => $('.advisor'), 8000, 'model advisor');
      await T.log('advisor: ' + adv.textContent.replace(/\s+/g, ' ').trim());
      await shot('23-model-advisor', 500);
      // fake an already-downloaded Medium so "switch" can be tested without a 3 GB download
      const dir = app.getState().settings.local.modelsDir + '\\medium';
      const big = 'x'.repeat(1100 * 1024);
      await api.writeFile(dir + '\\Qwen3.5-4B-Q4_K_M.gguf', big);
      await api.writeFile(dir + '\\mmproj-F16.gguf', big);
      app.setState({ localModels: await api.localModels() });
      const sw = await waitFor(() => byText('.advisor button', 'Przełącz na', 'Switch to'), 5000, 'switch button');
      sw.click();
      await waitFor(() => !$('.advisor') && app.getState().settings.activeModel.model === 'medium', 8000, 'switched to medium');
      const c2 = await api.getChat(c.id);
      if (c2.model.model !== 'medium') throw new Error('chat model not switched: ' + JSON.stringify(c2.model));
      await T.log('advisor switch OK: active=' + JSON.stringify(app.getState().settings.activeModel));
      await shot('24-after-switch', 700);
      // back to High: advisor shows again, X hides it for good
      await api.setChatModel(c.id, { provider: 'local', model: 'high' });
      const adv2 = await waitFor(() => $('.advisor'), 8000, 'advisor again');
      click(adv2.querySelector('.icon-btn'), 'advisor dismiss');
      await waitFor(() => !$('.advisor'), 5000, 'advisor dismissed');
      if (!(app.getState().settings.ui.dismissed || []).includes('high>medium')) throw new Error('dismiss not saved');
      await T.log('advisor dismiss OK');
    }

    // menus: clicking the button that opened a menu closes it (it used to pop open again)
    {
      const press = (el) => {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.click();
      };
      for (const [sel, what] of [['.menu-btn', 'title menu'], ['.composer .chip-btn', 'composer mode menu']]) {
        const btn = await waitFor(() => $(sel), 5000, what);
        press(btn);
        await waitFor(() => $('.menu'), 3000, what + ' open');
        press(btn);
        await sleep(250);
        if ($('.menu')) throw new Error(what + ': second click did not close the menu');
        press(btn);
        await waitFor(() => $('.menu'), 3000, what + ' reopen');
        press(document.querySelector('.workbench') || document.body);
        await sleep(200);
        if ($('.menu')) throw new Error(what + ': click outside did not close the menu');
      }
      await T.log('MENU TOGGLE OK');
    }

    await T.log('ALL OK');
  } catch (e) {
    await T.log('TEST ERROR: ' + (e && e.stack ? e.stack : e));
    try {
      await T.capture('99-error');
    } catch {}
  }
  await sleep(500);
  await T.quit();
})();
