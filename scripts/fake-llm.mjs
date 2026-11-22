// Fake LLM server speaking the OpenAI chat-completions and Anthropic Messages streaming protocols.
// Used by scripts/run-provider-test.mjs to test Lunarix's provider adapters and agent loop end-to-end.
import http from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

export function startFakeLLM(logFile) {
  writeFileSync(logFile, '');
  const log = (s) => appendFileSync(logFile, s + '\n');
  const problems = [];
  const fail = (msg) => {
    problems.push(msg);
    log('VALIDATION FAIL: ' + msg);
  };

  const sse = (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const chunks = (s, n = 7) => s.match(new RegExp(`.{1,${n}}`, 'gs')) || [];

  // ---------------------------------------------------------------- OpenAI
  async function openai(body, res) {
    const msgs = body.messages || [];
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    const step = toolMsgs.length;
    if (!body.tools?.length) {
      // utility request (chat title, prompt enhancer…)
      log(`[openai] utility request max_tokens=${body.max_tokens}`);
      sse(res);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Plik hello i środowisko' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    log(`[openai] step=${step} msgs=${msgs.length} tools=${(body.tools || []).length} stream_options=${JSON.stringify(body.stream_options)} max_tokens=${body.max_tokens}`);
    if (step === 0) {
      const u = msgs.find((m) => m.role === 'user');
      const t = typeof u?.content === 'string' ? u.content : JSON.stringify(u?.content);
      const checks = [
        [/type="archive"/.test(t) && /index\.php/.test(t) && /Hello from PHP/.test(t), 'zip listing + inlined PHP'],
        [/Hello PDF/.test(t), 'pdf text'],
        [/Hello DOCX/.test(t) && /Second paragraph/.test(t), 'docx text'],
        [/app\.cs/.test(t), 'C# file in zip listing']
      ];
      for (const [ok, what] of checks) ok ? log('[openai] attachment OK: ' + what) : fail('openai: attachment missing: ' + what);
    }
    if (!body.stream) fail('openai: stream not set');
    if (!Array.isArray(body.tools) || !body.tools.some((t) => t.function?.name === 'write_file')) fail('openai: write_file tool missing');
    if (msgs[0]?.role !== 'system') fail('openai: first message is not system');
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'fake-coder' };
    sse(res);
    if (step === 0) {
      const last = msgs[msgs.length - 1];
      const userText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      if (!/MODE: AGENT/.test(userText)) fail('openai: mode tag missing in user message');
      for (const c of chunks('Let me think about the file structure first.')) {
        write({ ...base, choices: [{ index: 0, delta: { reasoning_content: c } }] });
        await sleep(5);
      }
      for (const c of chunks('Tworzę plik hello.txt.')) {
        write({ ...base, choices: [{ index: 0, delta: { content: c } }] });
        await sleep(5);
      }
      const args = JSON.stringify({ path: 'hello.txt', content: 'Hello from the fake OpenAI model!\nLine 2\n' });
      write({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'write_file', arguments: '' } }] } }] });
      for (const c of chunks(args, 9)) {
        write({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: c } }] } }] });
        await sleep(3);
      }
      write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      write({ ...base, choices: [], usage: { prompt_tokens: 2100, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 0 } } });
    } else if (step === 1) {
      const asst = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
      if (!asst || asst.tool_calls[0].function.name !== 'write_file') fail('openai step1: assistant tool_calls not replayed');
      if (asst && JSON.parse(asst.tool_calls[0].function.arguments).path !== 'hello.txt') fail('openai step1: tool args not replayed correctly');
      const tm = msgs.find((m) => m.role === 'tool');
      if (!tm || tm.tool_call_id !== 'call_abc') fail('openai step1: tool result id mismatch');
      if (tm && !/Created hello\.txt/.test(tm.content)) fail('openai step1: unexpected tool result: ' + tm.content);
      const args = JSON.stringify({ path: 'hello.txt', old_text: 'Line 2', new_text: 'Line 2 (edited by agent)' });
      write({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_def', type: 'function', function: { name: 'edit_file', arguments: args } }] } }] });
      write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      write({ ...base, choices: [], usage: { prompt_tokens: 2400, completion_tokens: 60 } });
    } else if (step === 2) {
      const tm = msgs.filter((m) => m.role === 'tool')[1];
      if (!tm || !/Edited hello\.txt/.test(tm.content)) fail('openai step2: edit result missing: ' + (tm && tm.content));
      // Qwen-style text tool call inside content (tests the fallback parser)
      const text = 'Sprawdzam środowisko.\n<tool_call>\n<function=run_command>\n<parameter=command>\necho LUNARIX_OK\n</parameter>\n</function>\n</tool_call>';
      for (const c of chunks(text, 11)) {
        write({ ...base, choices: [{ index: 0, delta: { content: c } }] });
        await sleep(3);
      }
      write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      write({ ...base, choices: [], usage: { prompt_tokens: 2600, completion_tokens: 40 } });
    } else {
      const tm = msgs.filter((m) => m.role === 'tool')[2];
      if (!tm || !/LUNARIX_OK/.test(tm.content)) fail('openai step3: command output missing: ' + (tm && tm.content));
      for (const c of chunks('Gotowe! Plik **hello.txt** został utworzony i poprawiony, a komenda zwróciła `LUNARIX_OK`.')) {
        write({ ...base, choices: [{ index: 0, delta: { content: c } }] });
        await sleep(4);
      }
      write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      write({ ...base, choices: [], usage: { prompt_tokens: 2800, completion_tokens: 30 } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }

  // ---------------------------------------------------------- flaky model
  // 1st request: connection dies mid tool call (engine crash / "terminated")
  // 2nd: reasoning only, then stop (no text, no tool call)
  // 3rd: must contain the auto-continue nudge; streams prompt progress, then a tool call
  // 4th: final answer
  let flakyCalls = 0;
  async function flaky(body, res) {
    flakyCalls++;
    const msgs = body.messages || [];
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id: 'chatcmpl-f', object: 'chat.completion.chunk', created: 1, model: 'fake-flaky' };
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '');
    log(`[flaky] call=${flakyCalls} msgs=${msgs.length} assistants=${msgs.filter((m) => m.role === 'assistant').length} lastUser=${lastUserText.slice(0, 70).replace(/\n/g, ' ')}`);
    sse(res);
    if (flakyCalls === 1) {
      for (const c of chunks('Planning the file.')) {
        write({ ...base, choices: [{ index: 0, delta: { reasoning_content: c } }] });
        await sleep(5);
      }
      write({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_f1', type: 'function', function: { name: 'write_file', arguments: '{"path":"flaky.txt","content":"partial' } }] } }] });
      await sleep(80);
      log('[flaky] dropping the connection mid-stream');
      res.socket.destroy();
      return;
    }
    if (flakyCalls === 2) {
      if (msgs.some((m) => m.role === 'assistant')) fail('flaky: the broken partial reply must not be replayed');
      for (const c of chunks('I will create flaky.txt next.')) {
        write({ ...base, choices: [{ index: 0, delta: { reasoning_content: c } }] });
        await sleep(5);
      }
      write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      write({ ...base, choices: [], usage: { prompt_tokens: 900, completion_tokens: 12 } });
    } else if (flakyCalls === 3) {
      if (!/Automatic message from Lunarix/.test(lastUserText)) fail('flaky: auto-continue nudge missing, last user message: ' + lastUserText.slice(0, 200));
      else log('[flaky] auto-continue nudge OK');
      write({ ...base, choices: [], prompt_progress: { total: 1000, cache: 0, processed: 400, time_ms: 100 } });
      await sleep(400);
      write({ ...base, choices: [], prompt_progress: { total: 1000, cache: 0, processed: 1000, time_ms: 250 } });
      const args = JSON.stringify({ path: 'flaky.txt', content: 'Recovered after a dropped stream ✓\n' });
      write({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_f2', type: 'function', function: { name: 'write_file', arguments: args } }] } }] });
      write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      write({ ...base, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 30 } });
    } else {
      const tm = msgs.filter((m) => m.role === 'tool').pop();
      if (!tm || !/flaky\.txt/.test(tm.content)) fail('flaky: write_file result missing: ' + (tm && tm.content));
      for (const c of chunks('Gotowe — połączenie odzyskane, plik flaky.txt zapisany.')) {
        write({ ...base, choices: [{ index: 0, delta: { content: c } }] });
        await sleep(4);
      }
      write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      write({ ...base, choices: [], usage: { prompt_tokens: 1100, completion_tokens: 20 } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }

  // ------------------------------------------------------------- Anthropic
  async function anthropic(body, headers, res) {
    const msgs = body.messages || [];
    const assistants = msgs.filter((m) => m.role === 'assistant').length;
    const step = assistants;
    const evu = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    if (!body.tools?.length) {
      log(`[anthropic] utility request effort=${JSON.stringify(body.output_config)} max_tokens=${body.max_tokens}`);
      sse(res);
      evu('message_start', { message: { id: 'msg_u', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } });
      evu('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      evu('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Plik anthropic.txt' } });
      evu('content_block_stop', { index: 0 });
      evu('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } });
      evu('message_stop', {});
      res.end();
      return;
    }
    if (step === 0) {
      const img = msgs[0]?.content?.find?.((b) => b.type === 'image');
      if (!img || img.source?.type !== 'base64' || img.source?.media_type !== 'image/png' || !(img.source?.data?.length > 50))
        fail('anthropic: PNG attachment not sent as image block: ' + JSON.stringify((msgs[0]?.content || []).map((b) => (b.type === 'image' ? { type: 'image', media: b.source?.media_type, len: b.source?.data?.length } : { type: b.type, text: String(b.text || '').slice(0, 160) }))));
      else log('[anthropic] attachment OK: image block ' + img.source.data.length + ' b64 chars');
    }
    log(`[anthropic] step=${step} model=${body.model} msgs=${msgs.length} thinking=${JSON.stringify(body.thinking)} output_config=${JSON.stringify(body.output_config)} fallbacks=${JSON.stringify(body.fallbacks)} beta=${headers['anthropic-beta'] || ''} cache_control=${JSON.stringify(body.cache_control)} eager=${body.tools?.[0]?.eager_input_streaming}`);
    if (!body.stream) fail('anthropic: stream not set');
    if (!body.thinking || body.thinking.type !== 'adaptive') fail('anthropic: adaptive thinking not requested');
    if (body.temperature !== undefined) fail('anthropic: temperature must not be sent');
    if (!body.tools?.every((t) => t.eager_input_streaming === true)) fail('anthropic: eager_input_streaming missing');
    if (!body.cache_control) fail('anthropic: top-level cache_control missing');
    if (body.fallbacks !== 'default' || !/server-side-fallback-2026-07-01/.test(headers['anthropic-beta'] || '')) fail('anthropic: fallbacks/beta missing');
    if (typeof body.system === 'string' || !Array.isArray(body.system)) fail('anthropic: system should be block array');
    if (step >= 1) {
      const a = msgs[1];
      const th = a?.content?.find((b) => b.type === 'thinking');
      if (!th || th.signature !== 'sig-abc-123' || th.thinking !== 'I will create the file, then run a check.') fail('anthropic: thinking block not replayed verbatim: ' + JSON.stringify(a?.content?.[0]));
      const tu = a?.content?.find((b) => b.type === 'tool_use');
      if (!tu || tu.id !== 'toolu_01' || tu.input?.path !== 'anthropic.txt') fail('anthropic: tool_use not replayed: ' + JSON.stringify(tu));
      const u = msgs[2];
      const tr = u?.content?.[0];
      if (!tr || tr.type !== 'tool_result' || tr.tool_use_id !== 'toolu_01') fail('anthropic: tool_result missing/first: ' + JSON.stringify(u));
    }
    sse(res);
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { id: 'msg_' + step, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 300, cache_read_input_tokens: 1500, cache_creation_input_tokens: 200, output_tokens: 1 } } });
    let idx = 0;
    if (step === 0) {
      ev('content_block_start', { index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } });
      for (const c of chunks('I will create the file, then run a check.')) ev('content_block_delta', { index: idx, delta: { type: 'thinking_delta', thinking: c } });
      ev('content_block_delta', { index: idx, delta: { type: 'signature_delta', signature: 'sig-abc-123' } });
      ev('content_block_stop', { index: idx++ });
      ev('content_block_start', { index: idx, content_block: { type: 'text', text: '' } });
      for (const c of chunks('Tworzę plik anthropic.txt.')) ev('content_block_delta', { index: idx, delta: { type: 'text_delta', text: c } });
      ev('content_block_stop', { index: idx++ });
      ev('content_block_start', { index: idx, content_block: { type: 'tool_use', id: 'toolu_01', name: 'write_file', input: {} } });
      for (const c of chunks(JSON.stringify({ path: 'anthropic.txt', content: 'Written via the Anthropic protocol ✓\n' }), 8)) ev('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: c } });
      ev('content_block_stop', { index: idx++ });
      ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 140 } });
    } else if (step === 1) {
      ev('content_block_start', { index: idx, content_block: { type: 'tool_use', id: 'toolu_02', name: 'run_command', input: {} } });
      ev('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'echo ANTHROPIC_OK' }) } });
      ev('content_block_stop', { index: idx++ });
      ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } });
    } else {
      const lastUser = msgs[msgs.length - 1];
      const tr = lastUser?.content?.find((b) => b.type === 'tool_result');
      const txt = JSON.stringify(tr?.content || '');
      if (!/ANTHROPIC_OK/.test(txt)) fail('anthropic step2: command output missing: ' + txt.slice(0, 300));
      ev('content_block_start', { index: idx, content_block: { type: 'text', text: '' } });
      for (const c of chunks('Gotowe — protokół Anthropic działa poprawnie.')) ev('content_block_delta', { index: idx, delta: { type: 'text_delta', text: c } });
      ev('content_block_stop', { index: idx++ });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 25 } });
    }
    ev('message_stop', {});
    res.end();
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      try {
        const isAnthropic = !!req.headers['anthropic-version'] || !!req.headers['x-api-key'];
        if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (isAnthropic)
            res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5 (fake)', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' }));
          else res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-coder', object: 'model' }] }));
          return;
        }
        const body = raw ? JSON.parse(raw) : {};
        if (req.url.startsWith('/v1/chat/completions')) {
          if (!body.stream) {
            res.writeHead(400).end('{"error":{"message":"stream required"}}');
            return;
          }
          if (body.model === 'fake-flaky' && body.tools?.length) await flaky(body, res);
          else await openai(body, res);
        } else if (req.url.startsWith('/v1/messages')) await anthropic(body, req.headers, res);
        else res.writeHead(404).end();
      } catch (e) {
        log('SERVER ERROR ' + e.stack);
        try {
          res.writeHead(500).end();
        } catch {}
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, problems, close: () => server.close() }));
  });
}
