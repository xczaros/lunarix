// Renderer-side script: drives real agent runs against the fake OpenAI / Anthropic server.
(async () => {
  const T = window.lunarixTest;
  const PORT = __PORT__;
  const FX = __FIXTURES__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (m) => T.log(typeof m === 'string' ? m : JSON.stringify(m));
  const waitFor = async (fn, ms = 20000, what = '') => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await fn();
      if (v) return v;
      await sleep(200);
    }
    throw new Error('timeout: ' + what);
  };
  const summarize = (chat) =>
    chat.messages.map((m) => ({
      role: m.role,
      status: m.status,
      blocks: m.blocks.map((b) => (b.type === 'tool' ? `tool:${b.name}:${b.status}${b.result?.isError ? ':ERR ' + b.result.text.slice(0, 160) : ''}` : b.type === 'text' ? 'text:' + b.text.slice(0, 60).replace(/\n/g, ' ') : b.type === 'thinking' ? 'thinking:' + b.text.length : b.type === 'error' ? 'ERROR:' + b.text.slice(0, 200) : b.type)),
      usage: m.usage
    }));
  try {
    await waitFor(() => window.__lx && window.__lx.useApp.getState().ready, 20000, 'ready');
    const { api, useApp } = window.__lx;
    const s0 = useApp.getState().settings;
    await useApp.getState().patchSettings({ onboarded: true, agent: { ...s0.agent, approval: 'chill', showBrowser: false, autoTitle: true } });
    const proj = await api.getDefaultProject();
    useApp.setState({ projects: await api.listProjects() });
    await useApp.getState().selectProject(proj.id);
    await sleep(800);

    // ---------------- OpenAI-compatible
    await api.setProvider('custom', { baseUrl: `http://127.0.0.1:${PORT}/v1` });
    const models = await api.fetchModels('custom');
    log('custom models: ' + models.map((m) => m.id).join(','));
    await useApp.getState().refreshProviders();
    const c1 = await useApp.getState().newChat(proj.id);
    await api.setChatModel(c1.id, { provider: 'custom', model: 'fake-coder' });
    await api.sendMessage(c1.id, {
      text: 'Siemka! Stwórz plik hello.txt i sprawdź środowisko',
      mode: 'agent',
      attachments: [
        { kind: 'path', path: FX + '\\sample.zip' },
        { kind: 'path', path: FX + '\\sample.pdf' },
        { kind: 'path', path: FX + '\\sample.docx' }
      ]
    });
    const done1 = await waitFor(async () => {
      const c = await api.getChat(c1.id);
      return c && !c.running && c.messages.filter((m) => m.role === 'assistant').length >= 4 ? c : null;
    }, 60000, 'openai chat');
    log('OPENAI CHAT: title=' + done1.title + ' usage=' + JSON.stringify(done1.usage));
    log(summarize(done1));
    const f1 = await api.readFile(proj.path + '\\hello.txt');
    log('hello.txt => ' + JSON.stringify(f1.content));
    await sleep(600);
    await T.capture('p1-openai-chat');

    // ---------------- dropped stream + reasoning-only reply (auto retry / auto continue)
    const c3 = await useApp.getState().newChat(proj.id);
    await api.setChatModel(c3.id, { provider: 'custom', model: 'fake-flaky' });
    await api.sendMessage(c3.id, { text: 'Utwórz plik flaky.txt', mode: 'agent', attachments: [] });
    const done3 = await waitFor(async () => {
      const c = await api.getChat(c3.id);
      return c && !c.running && c.messages.some((m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'text' && /Gotowe/.test(b.text))) ? c : null;
    }, 60000, 'flaky chat');
    log('FLAKY CHAT:');
    log(summarize(done3));
    const notices = done3.messages.flatMap((m) => m.blocks.filter((b) => b.type === 'notice').map((b) => b.text));
    log('flaky notices: ' + JSON.stringify(notices));
    log('flaky autoContinue flags: ' + done3.messages.filter((m) => m.autoContinue).length);
    const f3 = await api.readFile(proj.path + '\\flaky.txt');
    log('flaky.txt => ' + JSON.stringify(f3.content));
    await sleep(600);
    await T.capture('p1b-flaky-chat');

    // ---------------- Anthropic
    await api.setProvider('anthropic', { apiKey: 'sk-ant-test-key' });
    const am = await api.fetchModels('anthropic');
    log('anthropic models: ' + am.map((m) => m.id + (m.adaptiveThinking ? '(adaptive)' : '')).join(','));
    const c2 = await useApp.getState().newChat(proj.id);
    await api.setChatModel(c2.id, { provider: 'anthropic', model: 'claude-opus-5-5' });
    await api.sendMessage(c2.id, { text: 'Utwórz plik anthropic.txt', mode: 'agent', attachments: [{ kind: 'path', path: FX + '\\shot.png' }] });
    const done2 = await waitFor(async () => {
      const c = await api.getChat(c2.id);
      return c && !c.running && c.messages.filter((m) => m.role === 'assistant').length >= 3 ? c : null;
    }, 60000, 'anthropic chat');
    log('ANTHROPIC CHAT: title=' + done2.title + ' usage=' + JSON.stringify(done2.usage));
    log(summarize(done2));
    const f2 = await api.readFile(proj.path + '\\anthropic.txt');
    log('anthropic.txt => ' + JSON.stringify(f2.content));
    await sleep(600);
    await T.capture('p2-anthropic-chat');

    // ---------------- checkpoint restore
    const firstUser = done1.messages.find((m) => m.role === 'user');
    const changes = await api.turnChanges(c1.id, firstUser.id);
    log('turn changes: ' + changes.map((c) => c.path.split('\\').pop() + (c.before === null ? '(new)' : '')).join(','));
    const r = await api.restoreCheckpoint(c1.id, firstUser.id);
    const exists = await api.exists(proj.path + '\\hello.txt');
    log(`restore: restored=${r.restored} text="${r.text}" hello.txt exists after restore=${exists}`);

    // ---------------- usage summary
    const u = await api.usage();
    log('usage today: ' + JSON.stringify(u.today));
    log('PROVIDER TEST DONE');
  } catch (e) {
    await log('TEST ERROR: ' + (e && e.stack ? e.stack : e));
    try {
      await T.capture('p9-error');
    } catch {}
  }
  await sleep(400);
  await T.quit();
})();
