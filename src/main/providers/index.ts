import type { ProviderId } from '@shared/types';
import { completeAnthropic, streamAnthropic } from './anthropic';
import { completeOpenAI, streamOpenAI } from './openai';
import type { ChatRequest, ChatResponse } from './types';
import { sleep, uid } from '../util';
import { beginEngineRequest, endEngineRequest } from '../engine/llama';

export async function streamChat(req: ChatRequest): Promise<ChatResponse> {
  if (req.provider === 'anthropic') return streamAnthropic(req);
  if (req.provider === 'mock') return streamMock(req);
  return streamOpenAI(req);
}

export async function completeText(provider: ProviderId, model: string, system: string, user: string, maxTokens = 400, baseUrlOverride?: string, signal?: AbortSignal) {
  if (provider === 'anthropic') return completeAnthropic(model, system, user, maxTokens, signal);
  if (provider === 'mock') return { text: user.split(/\s+/).slice(0, 5).join(' '), usage: { input: 10, output: 5 } };
  // keep the local engine from being unloaded as idle while it works on a long summary / edit
  if (provider === 'local') beginEngineRequest();
  try {
    return await completeOpenAI(provider, model, system, user, maxTokens, baseUrlOverride, signal);
  } finally {
    if (provider === 'local') endEngineRequest();
  }
}

// ------------------------------------------------------------------ mock
// Deterministic scripted agent used for automated UI tests (LUNARIX_MOCK=1).

async function typeOut(text: string, cb: (s: string) => void, signal: AbortSignal) {
  const parts = text.match(/.{1,6}/gs) || [];
  for (const p of parts) {
    if (signal.aborted) throw new Error('aborted');
    cb(p);
    await sleep(8);
  }
}

async function streamMock(req: ChatRequest): Promise<ChatResponse> {
  const turns = req.messages.filter((m) => m.role === 'assistant').length;
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const userText = lastUser && lastUser.role === 'user' ? lastUser.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ') : '';
  let said = '';
  let thought = '';
  const think = async (t: string) => {
    thought += t;
    await typeOut(t, (s) => req.cb.onThinking?.(s), req.signal);
  };
  const say = async (t: string) => {
    said += t;
    await typeOut(t, (s) => req.cb.onText?.(s), req.signal);
  };
  const usage = { input: 1200 + turns * 300, output: 180, estimated: false };
  const tool = async (name: string, input: any) => {
    const id = uid('mock_');
    req.cb.onToolStart?.(0, id, name);
    const json = JSON.stringify(input);
    for (const p of json.match(/.{1,40}/gs) || []) {
      req.cb.onToolDelta?.(0, p);
      await sleep(5);
    }
    return { text: said, thinking: thought, toolCalls: [{ id, name, input }], usage, stopReason: 'tool_calls' } as ChatResponse;
  };
  if (/^\/?ask|pytanie/i.test(userText) || req.tools === undefined || req.tools.length === 0) {
    await say('To jest odpowiedź testowa w trybie **Ask**. Mogę wyjaśnić kod, ale nie zmieniam plików.\n\n```js\nconsole.log("Lunarix");\n```');
    return { text: said, thinking: thought, toolCalls: [], usage, stopReason: 'stop' };
  }
  switch (turns) {
    case 0:
      await think('Użytkownik chce prostą stronę. Zaplanuję kroki: plan, plik HTML, test, podsumowanie.');
      await say('Zaczynam! Najpierw plan działania.');
      return tool('todo_write', {
        todos: [
          { content: 'Utworzyć index.html ze stroną', status: 'in_progress' },
          { content: 'Sprawdzić środowisko', status: 'pending' },
          { content: 'Przetestować stronę zrzutem ekranu', status: 'pending' }
        ]
      });
    case 1:
      await say('Tworzę plik strony.');
      return tool('write_file', {
        path: 'index.html',
        content:
          '<!doctype html>\n<html lang="pl">\n<head>\n<meta charset="utf-8">\n<title>Lunarix Demo</title>\n<style>\nbody{margin:0;height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#f5f5f5;font-family:system-ui}\nh1{font-weight:600;letter-spacing:-.02em}\n</style>\n</head>\n<body>\n<h1>Witaj w Lunarix 🌙</h1>\n</body>\n</html>\n'
      });
    case 2:
      return tool('run_command', { command: 'Get-ChildItem | Select-Object Name, Length' });
    case 3:
      return tool('todo_write', {
        todos: [
          { content: 'Utworzyć index.html ze stroną', status: 'completed' },
          { content: 'Sprawdzić środowisko', status: 'completed' },
          { content: 'Przetestować stronę zrzutem ekranu', status: 'in_progress' }
        ]
      });
    case 4:
      return tool('browser', { action: 'open', url: 'index.html' });
    default:
      await say('Gotowe! ✅\n\n- Utworzyłem `index.html`\n- Sprawdziłem pliki w projekcie\n- Przetestowałem stronę w przeglądarce\n\nMożesz otworzyć podgląd, aby zobaczyć efekt.');
      return { text: said, thinking: thought, toolCalls: [], usage, stopReason: 'stop' };
  }
}
