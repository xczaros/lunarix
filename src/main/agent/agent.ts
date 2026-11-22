import { BrowserWindow, powerSaveBlocker } from 'electron';
import { showNotification } from '../brand';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentMode, Block, Chat, LocalTierId, Message, ModelInfo, ModelRef, ProviderId, SendMessageInput, Todo, TokenUsage, ToolResult } from '@shared/types';
import { tierById, type LocalTier } from '@shared/catalog';
import { getChat, saveChat, getProject, getDefaultProject, renameChat, readBlobBase64, mimeOfBlob } from '../store';
import { settings, findModelInfo } from '../settings';
import { emit, log } from '../events';
import { paths } from '../paths';
import { completeText, streamChat } from '../providers';
import { ProviderError, type ChatResponse, type ConvMessage, type ConvPart, type ToolCall } from '../providers/types';
import { processAttachments } from '../attachments';
import { executeTool, toolCategory, toolsFor, commandRisk, resolvePath, type ToolContext } from './tools';
import { buildSystemPrompt, heuristicTitle, modeTag } from './prompt';
import { looksLikeTextToolCall, parseTextToolCalls, toolsAsText } from './xml';
import { toolchainSummary } from '../toolchain';
import { beginEngineRequest, endEngineRequest, engineContextSize, engineHasVision, engineHealthy, engineLogPath, ensureEngine, formatExitCode, lastEngineExit, stopEngine } from '../engine/llama';
import { recordLocalSpeed } from '../engine/hardware';
import { recordUsage } from '../usage';
import { errMsg, estimateTokens, isSubPath, sleep, throttle, uid } from '../util';

type ToolBlock = Extract<Block, { type: 'tool' }>;

interface QueuedMessage {
  text: string;
  attachments: Block[];
  mode: AgentMode;
}

interface Run {
  chatId: string;
  ctrl: AbortController;
  queue: QueuedMessage[];
  approvals: Map<string, (d: { decision: 'allow' | 'always' | 'deny'; feedback?: string }) => void>;
  answers: Map<string, (a: string) => void>;
  /** tool calls since the plan was last updated while it still had open items */
  todoAge?: number;
}

const runs = new Map<string, Run>();

const openTodos = (chat: Chat) => (chat.todos || []).filter((t) => t.status !== 'completed');

function setChatTodos(chat: Chat, todos: Todo[] | undefined) {
  chat.todos = todos;
  emit('chat:todos', { chatId: chat.id, todos: todos || [] });
}

/** The task is finished: tick whatever the model forgot to tick, so the plan matches reality. */
function completePlan(chat: Chat) {
  if (!chat.todos?.length || !openTodos(chat).length) return;
  setChatTodos(
    chat,
    chat.todos.map((t) => ({ ...t, status: 'completed' as const }))
  );
}
const sessionAllow = new Map<string, Set<string>>();

export const isRunning = (chatId: string) => runs.has(chatId);

const pl = () => settings().language === 'pl';

// Keep Windows from sleeping while an agent works — long autonomous tasks are the point.
let awakeId: number | null = null;
function updateAwake() {
  try {
    if (runs.size > 0 && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
    else if (runs.size === 0 && awakeId !== null) {
      powerSaveBlocker.stop(awakeId);
      awakeId = null;
    }
  } catch {
    /* not critical */
  }
}

const AUTO_CONTINUE =
  '[Automatic message from Lunarix] Your last reply ended without a visible answer or a tool call. Continue the task now: call the next tool you need — or, if the work is completely finished, write the final answer for the user.';

// ---------------------------------------------------------------- emitting

const emitters = new Map<string, (chat: Chat, msg: Message) => void>();
function pushMsg(chat: Chat, msg: Message, immediate = false) {
  if (immediate) {
    emit('chat:message', { chatId: chat.id, message: msg });
    return;
  }
  let f = emitters.get(msg.id);
  if (!f) {
    f = throttle((c: Chat, m: Message) => emit('chat:message', { chatId: c.id, message: m }), 70);
    emitters.set(msg.id, f);
  }
  f(chat, msg);
}

function setStatus(chat: Chat, text: string) {
  emit('chat:status', { chatId: chat.id, text });
}

function emitRun(chat: Chat, state: 'running' | 'idle', done = false) {
  emit('chat:run', { chatId: chat.id, state, done, title: chat.title, projectId: chat.projectId });
}

// ----------------------------------------------------------------- blocks

function lastBlock(m: Message) {
  return m.blocks[m.blocks.length - 1];
}

function appendText(m: Message, d: string) {
  const b = lastBlock(m);
  if (b && b.type === 'text') b.text += d;
  else {
    closeThinking(m);
    m.blocks.push({ type: 'text', text: d });
  }
}

function appendThinking(m: Message, d: string) {
  const b = lastBlock(m);
  if (b && b.type === 'thinking' && !b.done) b.text += d;
  else m.blocks.push({ type: 'thinking', text: d });
}

function closeThinking(m: Message) {
  for (const b of m.blocks) if (b.type === 'thinking') b.done = true;
}

function visibleText(m: Message) {
  return m.blocks
    .filter((b) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
}

function setVisibleText(m: Message, text: string) {
  const first = m.blocks.findIndex((b) => b.type === 'text');
  m.blocks = m.blocks.filter((b, i) => b.type !== 'text' || i === first);
  const b = m.blocks.find((x) => x.type === 'text') as any;
  if (b) b.text = text;
  else if (text) m.blocks.unshift({ type: 'text', text });
  if (b && !text) m.blocks = m.blocks.filter((x) => x !== b);
}

// ------------------------------------------------------------- model ctx

interface ModelCtx {
  ref: ModelRef;
  provider: ProviderId;
  model: string;
  info?: ModelInfo;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  compact: boolean;
  textTools: boolean;
  baseUrl?: string;
  tier?: LocalTier;
}

async function resolveModel(chat: Chat): Promise<ModelCtx> {
  const ref = chat.model;
  if (ref.provider === 'local') {
    const tierId = (ref.model || settings().local.tier) as LocalTierId;
    const tier = tierById(tierId);
    const baseUrl = await ensureEngine(tierId);
    const ctx = engineContextSize() || tier.defaultContext;
    return { ref, provider: 'local', model: `lunarix-${tier.id}`, vision: engineHasVision(), contextWindow: ctx, maxTokens: Math.min(16384, Math.floor(ctx / 2)), compact: tierId === 'low', textTools: !!chat.compat, baseUrl, tier };
  }
  if (ref.provider === 'mock') {
    return { ref, provider: 'mock', model: 'mock', vision: true, contextWindow: 200_000, maxTokens: 8000, compact: false, textTools: false };
  }
  const info = findModelInfo(ref.provider, ref.model);
  const vision = info?.vision ?? (ref.provider === 'anthropic' || ref.provider === 'google' || ref.provider === 'openai');
  const contextWindow = info?.contextWindow || (ref.provider === 'anthropic' ? 200_000 : ref.provider === 'google' ? 1_000_000 : 128_000);
  let maxTokens = info?.maxOutput ? Math.min(info.maxOutput, ref.provider === 'anthropic' ? 64_000 : 32_768) : ref.provider === 'anthropic' ? 32_000 : 16_384;
  maxTokens = Math.max(1024, Math.min(maxTokens, Math.floor(contextWindow / 2)));
  return { ref, provider: ref.provider, model: ref.model, info, vision, contextWindow, maxTokens, compact: false, textTools: !!chat.compat || info?.tools === false };
}

// --------------------------------------------------------- conversation

const blobCache = new Map<string, string>();
function blobData(id: string): string | null {
  if (blobCache.has(id)) return blobCache.get(id)!;
  const d = readBlobBase64(id);
  if (d) {
    blobCache.set(id, d);
    if (blobCache.size > 60) blobCache.delete(blobCache.keys().next().value as string);
  }
  return d;
}

function userParts(m: Message): ConvPart[] {
  const texts: string[] = [];
  if (m.hidden) texts.push(m.hidden);
  const images: ConvPart[] = [];
  for (const b of m.blocks) {
    if (b.type === 'attachment') {
      texts.push(b.modelText);
      for (const img of b.images || []) {
        const data = blobData(img.blobId);
        if (data) images.push({ type: 'image', mime: img.mime, data });
      }
    } else if (b.type === 'image') {
      const data = blobData(b.blobId);
      if (data) images.push({ type: 'image', mime: b.mime || mimeOfBlob(b.blobId), data });
    }
  }
  const userText = m.blocks
    .filter((b) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');
  texts.push(userText || '(no text)');
  return [{ type: 'text', text: texts.join('\n\n') }, ...images];
}

function resultOf(b: ToolBlock): { text: string; isError: boolean; images: ConvPart[] } {
  if (b.result) {
    const images: ConvPart[] = [];
    for (const img of b.result.images || []) {
      const data = blobData(img.blobId);
      if (data) images.push({ type: 'image', mime: img.mime, data });
    }
    return { text: b.result.text || '(no output)', isError: !!b.result.isError, images };
  }
  const text = b.status === 'denied' ? 'The user denied this action.' : 'Cancelled by the user before it finished.';
  return { text, isError: true, images: [] };
}

function renderCallXml(b: ToolBlock) {
  const params = Object.entries(b.input || {})
    .map(([k, v]) => `<parameter=${k}>\n${typeof v === 'string' ? v : JSON.stringify(v)}\n</parameter>`)
    .join('\n');
  return `<tool_call>\n<function=${b.name}>\n${params}\n</function>\n</tool_call>`;
}

function isSkippable(m: Message) {
  return m.role === 'assistant' && !m.blocks.some((b) => (b.type === 'text' && b.text.trim()) || b.type === 'tool');
}

function buildConversation(chat: Chat, mc: ModelCtx): ConvMessage[] {
  const conv: ConvMessage[] = [];
  const start = chat.compactAt ?? 0;
  if (start > 0 && chat.summary) {
    conv.push({
      role: 'user',
      content: [{ type: 'text', text: `<conversation_summary>\n${chat.summary}\n</conversation_summary>\n\nThe earlier part of this session was summarized above (context was compacted). Continue the work from here.` }]
    });
  }
  const msgs = chat.messages;
  for (let i = start; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.status === 'streaming' && m.role === 'assistant') continue;
    if (m.role === 'user') {
      conv.push({ role: 'user', content: userParts(m) });
      continue;
    }
    if (isSkippable(m)) {
      if (m.autoContinue) conv.push({ role: 'user', content: [{ type: 'text', text: AUTO_CONTINUE }] });
      continue;
    }
    const tools = m.blocks.filter((b) => b.type === 'tool') as ToolBlock[];
    if (mc.textTools) {
      const raw = m.raw?.provider === 'text' ? String(m.raw.content[0] || '') : visibleText(m) + (tools.length ? '\n' + tools.map(renderCallXml).join('\n') : '');
      conv.push({ role: 'assistant', text: raw || '…', toolCalls: [] });
      if (tools.length) {
        const parts: ConvPart[] = [];
        const texts: string[] = [];
        for (const t of tools) {
          const r = resultOf(t);
          texts.push(`<tool_result name="${t.name}"${r.isError ? ' error="true"' : ''}>\n${r.text}\n</tool_result>`);
          parts.push(...r.images);
        }
        conv.push({ role: 'user', content: [{ type: 'text', text: texts.join('\n') }, ...parts] });
      }
      continue;
    }
    const useRaw = m.raw?.provider === 'anthropic' && mc.provider === 'anthropic';
    conv.push({
      role: 'assistant',
      text: visibleText(m),
      toolCalls: tools.map((t) => ({ id: t.id, name: t.name, input: t.input ?? {} })),
      raw: useRaw ? m.raw!.content : undefined,
      stripThinking: chat.stripThinkingBefore !== undefined && i < chat.stripThinkingBefore
    });
    for (const t of tools) {
      const r = resultOf(t);
      conv.push({ role: 'tool', toolCallId: t.id, name: t.name, content: [{ type: 'text', text: r.text }, ...r.images], isError: r.isError });
    }
  }
  // the conversation must end with a user turn
  const last = conv[conv.length - 1];
  if (!last || last.role === 'assistant') conv.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
  return conv;
}

function estimateConv(system: string, conv: ConvMessage[], toolsJson: number) {
  let chars = system.length + toolsJson;
  let images = 0;
  for (const m of conv) {
    if (m.role === 'assistant') {
      chars += m.text.length + JSON.stringify(m.toolCalls).length;
    } else {
      for (const p of m.content) {
        if (p.type === 'text') chars += p.text.length;
        else images++;
      }
    }
  }
  return Math.ceil(chars / 3.5) + images * 1500;
}

// --------------------------------------------------------------- approvals

function outsideProject(input: any, root: string) {
  const ps = [input?.path, input?.from, input?.to, input?.destination].filter((x) => typeof x === 'string');
  return ps.some((p) => !isSubPath(root, resolvePath(p, root)));
}

type Decision = 'allow' | 'ask' | 'forbidden';

function decide(name: string, input: any, mode: AgentMode, chat: Chat, root: string): Decision {
  const cat = toolCategory(name);
  const s = settings();
  if (mode !== 'agent' && (cat === 'edit' || cat === 'command' || cat === 'desktop')) return 'forbidden';
  if (name === 'run_command') {
    const risk = commandRisk(String(input?.command || ''));
    if (risk === 'dangerous') return 'ask';
    if (risk === 'risky' && s.agent.approval !== 'chill') return 'ask';
  }
  const allowed = sessionAllow.get(chat.id);
  if (allowed?.has(cat)) return 'allow';
  switch (s.agent.approval) {
    case 'chill':
      if (name === 'delete_path' && outsideProject(input, root)) return 'ask';
      return 'allow';
    case 'auto-edits':
      if (cat === 'edit') return outsideProject(input, root) ? 'ask' : 'allow';
      if (cat === 'command' || cat === 'desktop') return 'ask';
      return 'allow';
    default:
      if (cat === 'edit' || cat === 'command' || cat === 'desktop') return 'ask';
      return 'allow';
  }
}

function attention(chat: Chat, kind: 'approval' | 'question') {
  const win = BrowserWindow.getAllWindows().find((w) => (w as any).__lunarixMain);
  if (win && !win.isFocused() && !process.env.LUNARIX_TEST) {
    win.flashFrame(true);
    showNotification({
      title: kind === 'approval' ? (pl() ? 'Lunarix czeka na zgodę' : 'Lunarix needs approval') : pl() ? 'Lunarix ma pytanie' : 'Lunarix has a question',
      body: chat.title,
      onClick: () => {
        win.show();
        win.focus();
        emit('open-chat', { chatId: chat.id, projectId: chat.projectId });
      }
    });
  }
}

function notifyDone(chat: Chat) {
  const s = settings();
  const win = BrowserWindow.getAllWindows().find((w) => (w as any).__lunarixMain);
  if (!s.agent.notifyOnDone || !win) return;
  if (win.isFocused() || process.env.LUNARIX_TEST) return;
  win.flashFrame(true);
  showNotification({
    title: pl() ? 'Lunarix skończył ✓' : 'Lunarix is done ✓',
    body: chat.title,
    onClick: () => {
      win.show();
      win.focus();
      emit('open-chat', { chatId: chat.id, projectId: chat.projectId });
    }
  });
}

// ----------------------------------------------------------------- errors

/** The connection to the model broke mid-request (engine crash, dropped socket) — not an API error. */
function isBrokenStream(e: any) {
  if (e?.code === 'network') return true;
  if (e instanceof ProviderError && e.status >= 400) return false;
  const m = [e?.message, e?.code, e?.cause?.message, e?.cause?.code].filter(Boolean).join(' ').toLowerCase();
  return /terminated|socket hang up|econnreset|econnrefused|econnaborted|epipe|other side closed|premature close|aborted|fetch failed|und_err/.test(m);
}

function friendlyError(e: any, mc?: Partial<ModelCtx>): { text: string; code?: string } {
  const P = pl();
  const prov = mc?.provider || '';
  if (e?.code === 'model_missing') return { text: e.message, code: 'model_missing' };
  if (prov === 'local' && isBrokenStream(e)) {
    const ex = lastEngineExit();
    const recent = ex && Date.now() - ex.at < 15 * 60_000;
    const crash = recent ? (P ? ` Silnik zakończył działanie z kodem ${formatExitCode(ex!.code)}.` : ` The engine exited with code ${formatExitCode(ex!.code)}.`) + (ex!.tail ? `\n\n${ex!.tail}` : '') : '';
    return {
      text: P
        ? `Lokalny model przerwał odpowiedź (${errMsg(e)}).${crash}\n\nKliknij „Ponów”. Jeśli to się powtarza: wybierz mniejszy model (np. Medium), zmniejsz rozmiar kontekstu albo wyłącz moduł widzenia w Ustawieniach → Modele lokalne.\nPełny log silnika: ${engineLogPath()}`
        : `The local model stopped responding (${errMsg(e)}).${crash}\n\nClick "Retry". If it keeps happening: pick a smaller model (e.g. Medium), lower the context size or turn off vision in Settings → Local models.\nFull engine log: ${engineLogPath()}`,
      code: 'engine_crash'
    };
  }
  if (isBrokenStream(e) && e?.code !== 'network') {
    return {
      text: P
        ? `Połączenie z modelem zostało przerwane w trakcie odpowiedzi (${errMsg(e)}). Kliknij „Ponów” — agent dokończy od miejsca, w którym przerwał.`
        : `The connection to the model dropped mid-response (${errMsg(e)}). Click "Retry" — the agent continues where it stopped.`,
      code: 'network'
    };
  }
  if (e instanceof ProviderError || e?.status !== undefined) {
    if (e.code === 'auth' || e.status === 401 || e.status === 403)
      return { text: P ? `Klucz API dla „${prov}” jest nieprawidłowy lub nie ma dostępu do tego modelu. Sprawdź Ustawienia → Modele i klucze API.\n\n${e.message}` : `The API key for "${prov}" is invalid or lacks access to this model. Check Settings → Models & API keys.\n\n${e.message}`, code: 'auth' };
    if (e.status === 429)
      return { text: P ? `Dostawca „${prov}” zwrócił limit zapytań (429). Odczekaj chwilę albo przełącz na model lokalny Lunarix — działa bez limitów.\n\n${e.message}` : `Provider "${prov}" rate-limited the request (429). Wait a moment or switch to a local Lunarix model — no limits.\n\n${e.message}`, code: 'rate' };
    if (e.code === 'network') return { text: P ? `Brak połączenia z dostawcą. Sprawdź internet.\n\n${e.message}` : `Could not reach the provider. Check your connection.\n\n${e.message}`, code: 'network' };
    if (e.status === 404) return { text: P ? `Model nie został znaleziony u dostawcy. Pobierz aktualną listę modeli w Ustawieniach.\n\n${e.message}` : `Model not found. Refresh the model list in Settings.\n\n${e.message}`, code: 'not_found' };
  }
  return { text: errMsg(e) };
}

function isToolUnsupported(e: any) {
  const msg = String(e?.message || '').toLowerCase();
  return (e?.status === 400 || e?.status === 404 || e?.status === 422 || e?.status === 500) && /(tool|function).{0,40}(not supported|unsupported|not enabled|does not support|invalid)|does not support (tools|function)|tool_choice|tool use is not supported/.test(msg);
}

// ----------------------------------------------------------------- public

function newUserMessage(text: string, attachments: Block[], mode: AgentMode): Message {
  return { id: uid('m_'), role: 'user', blocks: [...attachments, { type: 'text', text }], createdAt: Date.now(), mode, hidden: modeTag(mode), status: 'done' };
}

export async function sendMessage(chatId: string, input: SendMessageInput) {
  const chat = getChat(chatId);
  if (!chat) throw new Error('Chat not found');
  const s = settings();
  const mode = (input.mode || chat.mode || s.agent.defaultMode) as AgentMode;
  if (input.model) chat.model = input.model;
  chat.mode = mode;
  const attachments = input.attachments?.length ? await processAttachments(chat.id, input.attachments) : [];
  const text = (input.text || '').trim();
  const run = runs.get(chatId);
  if (run) {
    run.queue.push({ text, attachments, mode });
    emit('chat:queue', { chatId, count: run.queue.length, items: run.queue.map((q) => q.text) });
    return;
  }
  const isFirst = !chat.messages.some((m) => m.role === 'user');
  // a finished plan belongs to the previous task — don't show it again for the new one
  if (chat.todos?.length && !openTodos(chat).length) setChatTodos(chat, undefined);
  const msg = newUserMessage(text, attachments, mode);
  chat.messages.push(msg);
  saveChat(chat);
  pushMsg(chat, msg, true);
  if (isFirst && !chat.titleLocked) titleChat(chat, text || attachments.map((a: any) => a.name).join(', '));
  startRun(chat);
}

export function retryChat(chatId: string) {
  const chat = getChat(chatId);
  if (!chat || runs.has(chatId)) return;
  while (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'assistant' && isSkippable(chat.messages[chat.messages.length - 1])) {
    const m = chat.messages.pop()!;
    emit('chat:message-removed', { chatId, messageId: m.id });
  }
  if (!chat.messages.length) return;
  saveChat(chat);
  startRun(chat);
}

function startRun(chat: Chat) {
  const run: Run = { chatId: chat.id, ctrl: new AbortController(), queue: [], approvals: new Map(), answers: new Map() };
  runs.set(chat.id, run);
  runLoop(chat, run).catch((e) => log('runLoop crashed', e));
}

export function stopChat(chatId: string) {
  const run = runs.get(chatId);
  if (!run) return;
  run.ctrl.abort();
  for (const r of run.approvals.values()) r({ decision: 'deny' });
  for (const r of run.answers.values()) r('(cancelled)');
  run.approvals.clear();
  run.answers.clear();
}

export function approveTool(chatId: string, toolId: string, decision: 'allow' | 'always' | 'deny', feedback?: string) {
  const r = runs.get(chatId)?.approvals.get(toolId);
  if (r) r({ decision, feedback });
}

export function answerTool(chatId: string, toolId: string, answer: string) {
  const r = runs.get(chatId)?.answers.get(toolId);
  if (r) r(answer);
}

export function stopAll() {
  for (const id of [...runs.keys()]) stopChat(id);
}

// ------------------------------------------------------------- titles

async function titleChat(chat: Chat, text: string) {
  const s = settings();
  const quick = heuristicTitle(text, s.language);
  renameChat(chat.id, quick, false);
  const prov = chat.model.provider;
  if (!s.agent.autoTitle || prov === 'local' || prov === 'mock') return;
  try {
    const r = await completeText(
      prov,
      chat.model.model,
      'You write very short, descriptive titles for chat conversations.',
      `Write a short title (2-6 words) describing this request. Use the same language as the request. Reply with the title only — no quotes, no trailing punctuation.\n\nRequest:\n${text.slice(0, 1500)}`,
      60
    );
    const t = r.text.split('\n')[0].replace(/^["'„“#*\s]+|["'”“*\s.]+$/g, '').slice(0, 70);
    const fresh = getChat(chat.id);
    if (t && fresh && !fresh.titleLocked) renameChat(chat.id, t, false);
    if (r.usage) recordUsage(prov, chat.model.model, r.usage, findModelInfo(prov, chat.model.model));
  } catch (e) {
    log('title generation failed', errMsg(e));
  }
}

// ---------------------------------------------------------- compaction

function renderTranscript(chat: Chat, budget: number) {
  const lines: string[] = [];
  if (chat.summary) lines.push(`PREVIOUS SUMMARY:\n${chat.summary}\n`);
  for (let i = chat.compactAt ?? 0; i < chat.messages.length; i++) {
    const m = chat.messages[i];
    if (m.role === 'user') {
      const t = m.blocks
        .map((b) => (b.type === 'text' ? b.text : b.type === 'attachment' ? `[attachment ${b.name}: ${b.summary}]` : ''))
        .join(' ')
        .trim();
      lines.push(`USER: ${t}`);
    } else {
      for (const b of m.blocks) {
        if (b.type === 'text' && b.text.trim()) lines.push(`ASSISTANT: ${b.text.trim()}`);
        if (b.type === 'tool') {
          const args = JSON.stringify(b.input || {});
          const res = (b.result?.text || b.status).slice(0, 600);
          lines.push(`TOOL ${b.name}(${args.length > 400 ? args.slice(0, 400) + '…' : args}) → ${res}`);
        }
      }
    }
  }
  let text = lines.join('\n');
  if (text.length > budget) text = '…\n' + text.slice(text.length - budget);
  return text;
}

async function compactNow(chat: Chat, mc: ModelCtx, signal?: AbortSignal) {
  setStatus(chat, pl() ? 'Kompaktuję kontekst rozmowy…' : 'Compacting conversation context…');
  const budget = Math.floor(Math.min(400_000, mc.contextWindow * 3.5 * 0.6));
  const transcript = renderTranscript(chat, budget);
  const r = await completeText(
    mc.provider,
    mc.model,
    'You summarize long AI coding sessions so the work can continue seamlessly in a fresh context.',
    `Summarize the session below so an AI coding agent can continue the work. Include: the user's goals and requirements, key decisions, every file created or changed (with paths and purpose), commands that work (install/build/run/test), current state, open problems and the exact next steps. Be specific and complete but concise (max ~900 words). Write in the user's language.\n\n<transcript>\n${transcript}\n</transcript>`,
    3000,
    mc.baseUrl,
    signal
  );
  if (!r.text.trim()) throw new Error('Empty summary');
  if (r.usage) recordUsage(mc.provider, mc.model, r.usage, mc.info);
  const last = chat.messages[chat.messages.length - 1];
  chat.summary = r.text.trim();
  chat.compactAt = last && last.role === 'user' ? chat.messages.length - 1 : chat.messages.length;
  const notice: Message = {
    id: uid('m_'),
    role: 'assistant',
    blocks: [{ type: 'notice', level: 'compact', text: pl() ? 'Kontekst został skompaktowany — wcześniejsza część rozmowy zastąpiona podsumowaniem.' : 'Context compacted — earlier conversation replaced by a summary.' }],
    createdAt: Date.now(),
    status: 'done'
  };
  if (last && last.role === 'user') chat.messages.splice(chat.messages.length - 1, 0, notice);
  else chat.messages.push(notice);
  if (last && last.role === 'user') chat.compactAt = chat.messages.length - 1;
  chat.contextTokens = estimateTokens(chat.summary);
  saveChat(chat);
  emit('chat:reload', { chatId: chat.id });
  setStatus(chat, '');
}

export async function compactChat(chatId: string) {
  const chat = getChat(chatId);
  if (!chat || runs.has(chatId)) return;
  const mc = await resolveModel(chat);
  await compactNow(chat, mc);
}

// -------------------------------------------------------------- the loop

function addUsage(a: TokenUsage, u: TokenUsage, cost: number): TokenUsage {
  return {
    input: (a.input || 0) + (u.input || 0),
    output: (a.output || 0) + (u.output || 0),
    cacheRead: (a.cacheRead || 0) + (u.cacheRead || 0),
    cacheWrite: (a.cacheWrite || 0) + (u.cacheWrite || 0),
    cost: (a.cost || 0) + cost,
    estimated: a.estimated || u.estimated
  };
}

function reconcileTools(am: Message, calls: ToolCall[]) {
  const streamed = am.blocks.filter((b) => b.type === 'tool') as ToolBlock[];
  const used = new Set<ToolBlock>();
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    let b = streamed.find((x) => x.id === c.id && !used.has(x)) || streamed.find((x) => !used.has(x) && x.name === c.name && !calls.some((cc) => cc.id === x.id));
    if (!b) {
      b = { type: 'tool', id: c.id, name: c.name, input: c.input, status: 'pending', startedAt: Date.now() };
      am.blocks.push(b);
    }
    used.add(b);
    b.id = c.id;
    b.name = c.name;
    b.input = c.input;
    b.status = 'pending';
    delete b.inputText;
  }
  am.blocks = am.blocks.filter((b) => b.type !== 'tool' || used.has(b as ToolBlock));
}

function cancelPending(am: Message) {
  for (const b of am.blocks) if (b.type === 'tool' && ['streaming', 'pending', 'awaiting-approval', 'awaiting-answer', 'running'].includes(b.status)) b.status = 'cancelled';
  closeThinking(am);
}

function waitApproval(run: Run, id: string) {
  return new Promise<{ decision: 'allow' | 'always' | 'deny'; feedback?: string }>((resolve) => {
    run.approvals.set(id, (d) => {
      run.approvals.delete(id);
      resolve(d);
    });
  });
}

async function runLoop(chat: Chat, run: Run) {
  const s0 = settings();
  const project = getProject(chat.projectId) || getDefaultProject();
  if (!fs.existsSync(project.path)) fs.mkdirSync(project.path, { recursive: true });
  chat.running = true;
  saveChat(chat);
  emitRun(chat, 'running');
  updateAwake();
  let finished = false;
  let signatureRetry = false;
  let compatRetry = false;
  let streamRetries = 0; // engine crash / dropped stream → (restart +) retry the step
  let autoContinues = 0; // consecutive replies with reasoning only
  try {
    if (!chat.systemPrompt) {
      const tc = await toolchainSummary().catch(() => 'unknown');
      chat.systemPrompt = buildSystemPrompt({ project, settings: s0, toolchain: tc, compact: chat.model.provider === 'local' && chat.model.model === 'low' });
    }
    const maxSteps = Math.max(5, s0.agent.maxSteps || 150);
    let step = 0;
    while (step < maxSteps) {
      step++;
      if (run.ctrl.signal.aborted) break;
      // inject messages the user queued while the agent was busy
      while (run.queue.length) {
        const q = run.queue.shift()!;
        const qm = newUserMessage(q.text, q.attachments, q.mode);
        chat.mode = q.mode;
        chat.messages.push(qm);
        pushMsg(chat, qm, true);
        emit('chat:queue', { chatId: chat.id, count: run.queue.length, items: run.queue.map((x) => x.text) });
      }
      const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user');
      const turnId = lastUser?.id || 'none';
      const mode = (lastUser?.mode || chat.mode || 'agent') as AgentMode;

      let mc: ModelCtx;
      try {
        if (chat.model.provider === 'local') setStatus(chat, pl() ? 'Uruchamiam lokalny model…' : 'Starting the local model…');
        mc = await resolveModel(chat);
      } catch (e) {
        const fe = friendlyError(e);
        const em: Message = { id: uid('m_'), role: 'assistant', blocks: [{ type: 'error', text: fe.text, code: fe.code || (e as any)?.code }], createdAt: Date.now(), status: 'error', model: chat.model, turnId };
        chat.messages.push(em);
        pushMsg(chat, em, true);
        break;
      } finally {
        setStatus(chat, '');
      }

      const tools = toolsFor({ compact: mc.compact });
      const system = chat.systemPrompt + (mc.textTools ? '\n\n' + toolsAsText(tools) : '');
      let conv = buildConversation(chat, mc);
      const est = estimateConv(system, conv, mc.textTools ? 0 : JSON.stringify(tools).length);
      if (settings().agent.autoCompact && est > mc.contextWindow * 0.8 && chat.messages.length > 3) {
        try {
          await compactNow(chat, mc, run.ctrl.signal);
          conv = buildConversation(chat, mc);
        } catch (e) {
          log('compaction failed', errMsg(e));
        }
      }

      const am: Message = { id: uid('m_'), role: 'assistant', blocks: [], createdAt: Date.now(), model: chat.model, status: 'streaming', turnId, mode };
      chat.messages.push(am);
      pushMsg(chat, am, true);
      const started = Date.now();
      const stepCtrl = new AbortController();
      const onAbort = () => stepCtrl.abort();
      run.ctrl.signal.addEventListener('abort', onAbort, { once: true });
      const toolBlocks = new Map<number, ToolBlock>();
      let streamedText = '';
      let textCallDone = false;
      let res: ChatResponse | null = null;
      if (mc.provider === 'local') beginEngineRequest();
      try {
        res = await streamChat({
          provider: mc.provider,
          model: mc.model,
          info: mc.info,
          system,
          messages: conv,
          tools: mc.textTools ? undefined : tools,
          maxTokens: mc.maxTokens,
          signal: stepCtrl.signal,
          effort: settings().agent.effort,
          thinking: settings().local.thinking,
          vision: mc.vision,
          baseUrlOverride: mc.baseUrl,
          fallback: settings().agent.anthropicFallback,
          cb: {
            onText: (d) => {
              streamedText += d;
              appendText(am, d);
              if (mc.textTools && !textCallDone && streamedText.includes('</tool_call>')) {
                textCallDone = true;
                stepCtrl.abort();
              }
              pushMsg(chat, am);
            },
            onThinking: (d) => {
              appendThinking(am, d);
              pushMsg(chat, am);
            },
            onToolStart: (i, id, name) => {
              closeThinking(am);
              const b: ToolBlock = { type: 'tool', id, name, input: {}, inputText: '', status: 'streaming', startedAt: Date.now() };
              am.blocks.push(b);
              toolBlocks.set(i, b);
              pushMsg(chat, am);
            },
            onToolDelta: (i, p) => {
              const b = toolBlocks.get(i);
              if (b) {
                b.inputText = (b.inputText || '') + p;
                pushMsg(chat, am);
              }
            },
            onStatus: (t) => setStatus(chat, t)
          }
        });
      } catch (e: any) {
        if (textCallDone && !run.ctrl.signal.aborted) {
          res = { text: streamedText, thinking: '', toolCalls: [], usage: { input: 0, output: 0, estimated: true }, stopReason: 'tool_call' };
        } else if (run.ctrl.signal.aborted) {
          am.status = 'stopped';
          cancelPending(am);
          pushMsg(chat, am, true);
          break;
        } else if (e?.code === 'thinking_signature' && !signatureRetry) {
          signatureRetry = true;
          chat.messages.pop();
          chat.stripThinkingBefore = chat.messages.length;
          emit('chat:message-removed', { chatId: chat.id, messageId: am.id });
          step--;
          continue;
        } else if (!compatRetry && !mc.textTools && isToolUnsupported(e)) {
          compatRetry = true;
          chat.compat = true;
          chat.messages.pop();
          emit('chat:message-removed', { chatId: chat.id, messageId: am.id });
          step--;
          continue;
        } else if (streamRetries < 2 && isBrokenStream(e) && (mc.provider === 'local' || e?.code !== 'network')) {
          // The response broke off mid-stream (local engine crash, dropped connection).
          // Local: restart the engine if it died. Then redo this step instead of failing the task.
          streamRetries++;
          const P = pl();
          let text: string;
          if (mc.provider === 'local') {
            const healthy = await engineHealthy();
            log('local stream broken', errMsg(e), 'engine healthy:', healthy, 'retry', streamRetries);
            if (!healthy) await stopEngine();
            const ex = lastEngineExit();
            const code = ex && Date.now() - ex.at < 60_000 ? ` (${P ? 'kod' : 'code'} ${formatExitCode(ex.code)})` : '';
            text = healthy
              ? P
                ? 'Połączenie z lokalnym modelem zostało przerwane — ponawiam ten krok.'
                : 'The connection to the local model dropped — retrying this step.'
              : P
                ? `Lokalny silnik nieoczekiwanie się zamknął${code} — uruchamiam go ponownie i ponawiam ten krok.`
                : `The local engine stopped unexpectedly${code} — restarting it and retrying this step.`;
          } else {
            log('stream broken', mc.provider, errMsg(e), 'retry', streamRetries);
            await sleep(1500 * streamRetries);
            text = P ? 'Połączenie z modelem zostało przerwane w trakcie odpowiedzi — ponawiam ten krok.' : 'The connection to the model dropped mid-response — retrying this step.';
          }
          am.blocks = [{ type: 'notice', level: 'warn', text }];
          am.status = 'done';
          pushMsg(chat, am, true);
          if (run.ctrl.signal.aborted) break;
          step--;
          continue;
        } else {
          const fe = friendlyError(e, mc);
          am.status = 'error';
          cancelPending(am);
          am.blocks.push({ type: 'error', text: fe.text, code: fe.code });
          pushMsg(chat, am, true);
          break;
        }
      } finally {
        run.ctrl.signal.removeEventListener('abort', onAbort);
        if (mc.provider === 'local') endEngineRequest();
      }
      if (!res) break;
      streamRetries = 0;
      am.durationMs = Date.now() - started;
      closeThinking(am);

      // tool calls written as text (fallback protocol / models that ignore native tools)
      let calls = res.toolCalls;
      const fullText = res.text || streamedText;
      if (!calls.length && (mc.textTools || looksLikeTextToolCall(fullText))) {
        const parsed = parseTextToolCalls(fullText, tools);
        if (parsed.calls.length) {
          calls = mc.textTools ? parsed.calls.slice(0, 1) : parsed.calls;
          if (mc.textTools) am.raw = { provider: 'text', content: [fullText] };
          setVisibleText(am, parsed.cleaned);
        }
      }
      // some local models write a complete tool call inside their reasoning block and then stop — recover it
      if (!calls.length && !fullText.trim() && res.thinking && looksLikeTextToolCall(res.thinking) && /<\/function>|<\/tool_call>/.test(res.thinking)) {
        const parsed = parseTextToolCalls(res.thinking, tools);
        if (parsed.calls.length) calls = mc.textTools ? parsed.calls.slice(0, 1) : parsed.calls;
      }
      if (mc.provider === 'anthropic' && res.raw) am.raw = { provider: 'anthropic', content: res.raw };
      if (res.thinking && !am.blocks.some((b) => b.type === 'thinking')) am.blocks.unshift({ type: 'thinking', text: res.thinking, done: true });
      reconcileTools(am, calls);

      // usage & cost
      let usage = res.usage;
      if (!usage.input && !usage.output) {
        usage = { input: estimateConv(system, conv, 0), output: estimateTokens(fullText + JSON.stringify(calls)), estimated: true };
      }
      const cost = recordUsage(mc.provider, mc.provider === 'local' ? `lunarix-${mc.tier?.id}` : mc.model, usage, mc.info);
      am.usage = { ...usage, cost };
      am.tokensPerSec = res.tokensPerSec ?? (usage.output && am.durationMs ? usage.output / Math.max(0.5, am.durationMs / 1000) : undefined);
      // real engine timings teach Lunarix how fast each local model is on this PC
      if (mc.provider === 'local' && mc.tier && res.tokensPerSec && !usage.estimated && (usage.output || 0) >= 24) recordLocalSpeed(mc.tier.id, res.tokensPerSec);
      chat.usage = addUsage(chat.usage || { input: 0, output: 0 }, usage, cost);
      chat.contextTokens = (usage.input || 0) + (usage.output || 0);

      if (res.refusal) {
        am.blocks.push({ type: 'error', text: pl() ? `Model odmówił wykonania tego zadania (kategoria: ${res.refusal}). Spróbuj przeformułować prośbę lub użyj innego modelu.` : `The model declined this request (category: ${res.refusal}). Try rephrasing or another model.`, code: 'refusal' });
        am.status = 'done';
        pushMsg(chat, am, true);
        break;
      }
      if ((res.stopReason === 'max_tokens' || res.stopReason === 'length') && calls.length) {
        am.blocks.push({ type: 'error', text: pl() ? 'Odpowiedź modelu została ucięta (limit długości) w trakcie wywołania narzędzia. Spróbuj ponownie — agent podzieli pracę na mniejsze kroki.' : 'The response was cut off (length limit) during a tool call. Retry — the agent will split the work into smaller steps.', code: 'truncated' });
        for (const b of am.blocks) if (b.type === 'tool') b.status = 'cancelled';
        am.status = 'error';
        pushMsg(chat, am, true);
        break;
      }
      am.status = 'done';
      pushMsg(chat, am, true);
      saveChat(chat);

      if (!calls.length) {
        if (run.queue.length) continue;
        // Reasoning only, no answer and no tool call (common with small local models that
        // "announce" the next step in their thoughts and stop): nudge it instead of ending the run.
        if (!visibleText(am).trim() && autoContinues < 2) {
          autoContinues++;
          am.autoContinue = true;
          am.blocks.push({
            type: 'notice',
            level: 'info',
            text: pl() ? 'Model zakończył odpowiedź samym myśleniem — automatycznie każę mu kontynuować.' : 'The model ended with reasoning only — automatically asking it to continue.'
          });
          pushMsg(chat, am, true);
          saveChat(chat);
          continue;
        }
        finished = true;
        if (mode === 'agent') completePlan(chat);
        break;
      }
      autoContinues = 0;

      for (const call of calls) {
        if (run.ctrl.signal.aborted) break;
        const b = am.blocks.find((x) => x.type === 'tool' && x.id === call.id) as ToolBlock | undefined;
        if (!b) continue;
        await runTool(chat, am, b, call, run, mc, project.path, mode, turnId);
        saveChat(chat);
      }
      if (run.ctrl.signal.aborted) {
        cancelPending(am);
        pushMsg(chat, am, true);
        break;
      }
    }
    if (step >= maxSteps && !finished && !run.ctrl.signal.aborted) {
      const nm: Message = { id: uid('m_'), role: 'assistant', blocks: [{ type: 'notice', level: 'warn', text: pl() ? `Osiągnięto limit ${maxSteps} kroków. Napisz „kontynuuj”, aby agent pracował dalej.` : `Reached the limit of ${maxSteps} steps. Say "continue" to keep going.` }], createdAt: Date.now(), status: 'done' };
      chat.messages.push(nm);
      pushMsg(chat, nm, true);
    }
  } catch (e) {
    log('agent error', e);
    const fe = friendlyError(e);
    const em: Message = { id: uid('m_'), role: 'assistant', blocks: [{ type: 'error', text: fe.text, code: fe.code }], createdAt: Date.now(), status: 'error' };
    chat.messages.push(em);
    pushMsg(chat, em, true);
  } finally {
    for (const m of chat.messages) if (m.status === 'streaming') m.status = 'stopped';
    chat.running = false;
    runs.delete(chat.id);
    updateAwake();
    saveChat(chat);
    emitRun(chat, 'idle', finished);
    if (finished) notifyDone(chat);
  }
}

async function runTool(chat: Chat, am: Message, b: ToolBlock, call: ToolCall, run: Run, mc: ModelCtx, root: string, mode: AgentMode, turnId: string) {
  b.input = call.input;
  if (call.invalid) {
    b.status = 'error';
    b.result = { text: `Invalid tool arguments (could not parse JSON): ${call.invalid.slice(0, 400)}\nCall the tool again with valid JSON arguments.`, isError: true };
    pushMsg(chat, am, true);
    return;
  }
  const decision = decide(call.name, call.input, mode, chat, root);
  if (decision === 'forbidden') {
    b.status = 'denied';
    b.result = { text: `The tool "${call.name}" is not allowed in ${mode.toUpperCase()} mode (read-only). Describe the change in your answer instead of performing it.`, isError: true };
    pushMsg(chat, am, true);
    return;
  }
  if (decision === 'ask') {
    b.status = 'awaiting-approval';
    pushMsg(chat, am, true);
    emit('chat:attention', { chatId: chat.id, kind: 'approval' });
    attention(chat, 'approval');
    const d = await waitApproval(run, b.id);
    if (run.ctrl.signal.aborted) {
      b.status = 'cancelled';
      return;
    }
    if (d.decision === 'deny') {
      b.status = 'denied';
      b.result = { text: `The user denied this action.${d.feedback ? ` User says: ${d.feedback}` : ' Try a different approach, or ask the user what they prefer.'}`, isError: true };
      pushMsg(chat, am, true);
      return;
    }
    if (d.decision === 'always') {
      const set = sessionAllow.get(chat.id) || new Set<string>();
      set.add(toolCategory(call.name));
      sessionAllow.set(chat.id, set);
    }
  }
  b.status = 'running';
  b.startedAt = Date.now();
  pushMsg(chat, am, true);
  let liveBuf = '';
  const flushLive = throttle(() => {
    b.live = liveBuf.length > 8000 ? liveBuf.slice(-8000) : liveBuf;
    pushMsg(chat, am);
  }, 120);
  const maxChars = Math.max(8000, Math.min(100_000, Math.floor(mc.contextWindow * 3.5 * 0.2)));
  const ctx: ToolContext = {
    chatId: chat.id,
    projectRoot: root,
    turnId,
    signal: run.ctrl.signal,
    settings: settings(),
    mode,
    vision: mc.vision,
    maxChars,
    live: (s: string) => {
      liveBuf += s;
      if (liveBuf.length > 20000) liveBuf = liveBuf.slice(-12000);
      emit('agent:output', { chatId: chat.id, toolId: b.id, data: s });
      flushLive();
    },
    ask: async (question: string, options?: string[]) => {
      b.status = 'awaiting-answer';
      b.question = { question, options };
      pushMsg(chat, am, true);
      emit('chat:attention', { chatId: chat.id, kind: 'question' });
      attention(chat, 'question');
      const answer = await new Promise<string>((resolve) => {
        run.answers.set(b.id, (a) => {
          run.answers.delete(b.id);
          resolve(a);
        });
      });
      b.status = 'running';
      pushMsg(chat, am, true);
      return answer;
    },
    setTodos: (todos) => {
      run.todoAge = 0;
      setChatTodos(chat, todos);
    }
  };
  try {
    const r: ToolResult = await executeTool(call.name, call.input, ctx);
    // Small models write a plan and then forget it. After a few tool calls without an
    // update, remind them (inside the tool result, where they actually read it).
    if (call.name !== 'todo_write' && !r.isError && openTodos(chat).length) {
      run.todoAge = (run.todoAge || 0) + 1;
      if (run.todoAge >= 3) {
        run.todoAge = 0;
        const open = openTodos(chat);
        r.text += `\n\n[Plan reminder: ${open.length} item(s) still open (${open.map((t) => `"${t.content}"`).slice(0, 4).join(', ')}). If you finished any of them, call todo_write now with the FULL list and mark them "completed".]`;
      }
    }
    b.result = r;
    b.status = r.isError ? 'error' : 'done';
  } catch (e) {
    b.result = { text: `Error: ${errMsg(e)}`, isError: true };
    b.status = run.ctrl.signal.aborted ? 'cancelled' : 'error';
  }
  b.endedAt = Date.now();
  b.live = undefined;
  pushMsg(chat, am, true);
}

// -------------------------------------------------- one-shot helpers

async function pickUtilityModel(): Promise<{ provider: ProviderId; model: string; baseUrl?: string }> {
  const s = settings();
  const ref = s.activeModel;
  if (ref.provider === 'local') {
    const baseUrl = await ensureEngine(ref.model as LocalTierId);
    return { provider: 'local', model: `lunarix-${ref.model}`, baseUrl };
  }
  return { provider: ref.provider, model: ref.model };
}

export async function enhancePrompt(text: string): Promise<string> {
  const m = await pickUtilityModel();
  const r = await completeText(
    m.provider,
    m.model,
    'You turn rough user requests into excellent prompts for an autonomous AI coding agent.',
    `Rewrite the request below into a clear, detailed, actionable prompt for an AI coding agent. Keep the user's language and intent. Add concrete requirements (features, sensible tech stack if implied, polished modern UI, error handling, testing/verification) but do not invent unrelated features. Output ONLY the improved prompt text.\n\nRequest:\n${text}`,
    1500,
    m.baseUrl
  );
  return r.text.replace(/^["'„]|["'”]$/g, '').trim() || text;
}

export async function inlineEdit(req: { filePath: string; language: string; code: string; before: string; after: string; instruction: string }): Promise<string> {
  const m = await pickUtilityModel();
  const r = await completeText(
    m.provider,
    m.model,
    'You are a precise code editing engine. You output only code.',
    `File: ${req.filePath} (${req.language})\n\nCode before the selection (context, do not repeat):\n\`\`\`\n${req.before.slice(-3000)}\n\`\`\`\n\nSELECTED CODE TO REWRITE:\n\`\`\`\n${req.code}\n\`\`\`\n\nCode after the selection (context, do not repeat):\n\`\`\`\n${req.after.slice(0, 2000)}\n\`\`\`\n\nInstruction: ${req.instruction}\n\nReturn ONLY the new code that replaces the selection — no explanations, no markdown fences. Keep the original indentation style.`,
    8000,
    m.baseUrl
  );
  let out = r.text;
  const fence = /^```[\w-]*\n([\s\S]*?)\n```\s*$/m.exec(out.trim());
  if (fence) out = fence[1];
  return out.replace(/^\n+|\s+$/g, '');
}

export async function oneShot(system: string, user: string, maxTokens = 800): Promise<string> {
  const m = await pickUtilityModel();
  const r = await completeText(m.provider, m.model, system, user, maxTokens, m.baseUrl);
  return r.text.trim();
}
