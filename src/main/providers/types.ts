import type { Effort, ModelInfo, ProviderId, TokenUsage } from '@shared/types';

export type ConvPart = { type: 'text'; text: string } | { type: 'image'; mime: string; data: string };

export interface ToolCall {
  id: string;
  name: string;
  input: any;
  invalid?: string; // parse error, if arguments could not be decoded
}

export type ConvMessage =
  | { role: 'user'; content: ConvPart[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw?: any[]; stripThinking?: boolean }
  | { role: 'tool'; toolCallId: string; name: string; content: ConvPart[]; isError?: boolean };

export interface ToolDef {
  name: string;
  description: string;
  parameters: any;
}

export interface StreamCallbacks {
  onText?(delta: string): void;
  onThinking?(delta: string): void;
  onToolStart?(index: number, id: string, name: string): void;
  onToolDelta?(index: number, partialJson: string): void;
  onStatus?(text: string): void;
}

export interface ChatRequest {
  provider: ProviderId;
  model: string;
  info?: ModelInfo;
  system: string;
  messages: ConvMessage[];
  tools?: ToolDef[];
  maxTokens: number;
  signal: AbortSignal;
  cb: StreamCallbacks;
  effort?: Effort;
  thinking?: boolean;
  vision: boolean;
  baseUrlOverride?: string;
  fallback?: boolean;
}

export interface ChatResponse {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  stopReason: string;
  raw?: any[];
  tokensPerSec?: number;
  servedModel?: string;
  refusal?: string;
}

export class ProviderError extends Error {
  constructor(message: string, public status = 0, public retryable = false, public code?: string) {
    super(message);
  }
}
