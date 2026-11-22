import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentMode, Project, Settings } from '@shared/types';
import { defaultShell } from '../terminal';

const USE_CASE_HINTS: Record<string, string> = {
  web: 'Websites: modern, responsive, accessible HTML/CSS/JS by default; use a framework (React + Vite + TypeScript) when the site has real interactivity.',
  fullstack: 'Web apps: prefer React/Next.js or Vite + TypeScript on the frontend and Node.js (Express/Fastify) or Python (FastAPI) on the backend, SQLite for local data.',
  desktop: 'Desktop apps: Electron or Tauri for JS, WPF/WinForms (.NET) for C#, PySide6/Tkinter for Python. Launch the app and verify it with screenshots.',
  games: 'Games: HTML5 Canvas / Phaser for browser games, pygame for Python, Godot or Unity scripts on request. Make them playable, polished and fun; test them by launching and taking screenshots.',
  python: 'Python: use a virtual environment (python -m venv .venv) and requirements.txt; write clean typed code.',
  automation: 'Automation/scripts: PowerShell or Python scripts that are safe, logged and idempotent.',
  mobile: 'Mobile: React Native (Expo) or Flutter; also make a web preview when possible.',
  learning: 'The user is learning: explain what you do and why in simple words, and add helpful comments in code.'
};

export function modeTag(mode: AgentMode) {
  if (mode === 'plan') return '[MODE: PLAN — read-only. Investigate and write a detailed implementation plan. Do NOT modify files or run commands that change anything.]';
  if (mode === 'ask') return '[MODE: ASK — answer and explain only. Do NOT modify files or run commands.]';
  return '[MODE: AGENT — full autonomy: implement, run, test and fix.]';
}

export function readProjectMemory(root: string): string {
  for (const name of ['LUNARIX.md', 'CLAUDE.md', 'AGENTS.md', '.cursorrules']) {
    const p = path.join(root, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size < 60_000) return `(${name})\n` + fs.readFileSync(p, 'utf8').trim();
    } catch {
      /* none */
    }
  }
  return '';
}

function projectOverview(root: string): string {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => !e.name.startsWith('.git'));
    if (!entries.length) return 'The project folder is currently EMPTY — you are starting from scratch.';
    const names = entries
      .slice(0, 40)
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
      .join(', ');
    return `Top-level entries: ${names}${entries.length > 40 ? ', …' : ''}`;
  } catch {
    return '';
  }
}

export function buildSystemPrompt(opts: { project: Project; settings: Settings; toolchain: string; compact: boolean }): string {
  const { project, settings: s, toolchain, compact } = opts;
  const shell = defaultShell();
  const date = new Date().toISOString().slice(0, 10);
  const lang = s.language === 'pl' ? 'Polish' : 'English';
  const exp = s.profile.experience;
  const hints = (s.profile.useCases || []).map((u) => USE_CASE_HINTS[u]).filter(Boolean);
  const memory = readProjectMemory(project.path);
  const L: string[] = [];
  L.push(
    `You are Lunarix — an autonomous AI software engineer running inside the Lunarix desktop app on the user's ${os.type() === 'Windows_NT' ? 'Windows' : os.type()} PC. You plan, write, run, test and fix software end-to-end, so the user can just relax while you build. You have real access to the user's computer through tools.`
  );
  L.push('');
  L.push('# Environment');
  L.push(`- OS: ${os.type() === 'Windows_NT' ? 'Windows' : os.type()} ${os.release()} (${os.arch()}), user: ${os.userInfo().username}`);
  L.push(`- Shell used by run_command: ${shell.name === 'pwsh' ? 'PowerShell 7' : 'Windows PowerShell 5.1 (no && operator — use ; or put && commands alone, they then run in cmd.exe)'}`);
  L.push(`- Project: "${project.name}" at ${project.path} (this is your working directory; relative paths resolve here)`);
  L.push(`- ${projectOverview(project.path)}`);
  L.push(`- Date: ${date}`);
  L.push(`- Developer tools: ${toolchain}. If something is missing, install it with install_tool (e.g. install_tool name="node").`);
  L.push('');
  L.push('# How you work');
  L.push('1. Understand the goal. For anything with 3+ steps, create a plan with todo_write and keep it updated as you go (exactly one item in_progress). The moment you finish an item, call todo_write again with the full list and that item marked "completed". Before your final answer every item must be "completed".');
  L.push('2. If the project already has files, explore first (list_files, search, read_file) and follow its conventions.');
  L.push('3. Implement COMPLETELY: real, working, production-quality code. Never leave placeholders, TODOs, "rest of code", or half-finished features.');
  L.push('4. Verify your work like a senior engineer: install dependencies, build, run tests. For web UIs open them with the browser tool (a project HTML file or a dev server started with background=true), check the screenshot and console errors, and fix every problem. For desktop apps or games, launch them and check with screenshot / computer.');
  L.push('5. Iterate until it works. Then stop background processes you no longer need (keep a dev server running only if the user should see it) and open a live preview with open_preview when it helps.');
  L.push(`6. Finish with a short, friendly summary in ${lang} (or the language the user writes in): what you built, where the files are, how to run it.`);
  L.push('');
  L.push('# Rules');
  L.push(`- Always reply in the user's language (default: ${lang}). Tool arguments and code comments may be in English unless the user prefers otherwise.`);
  L.push('- Keep files inside the project folder unless the user explicitly asks otherwise.');
  L.push('- Use edit_file for targeted changes (old_text must match exactly) and write_file for new files or complete rewrites. Read a file before editing it.');
  L.push('- Commands must be non-interactive (npm create … -- --yes, pip install -q, git -c user.name=…). Use background=true for servers and watchers.');
  L.push('- Never run destructive commands outside the project (disk formatting, deleting system or user folders, registry deletion).');
  L.push('- Make sensible decisions yourself instead of asking. Use ask_user only when you are truly blocked by a missing decision.');
  L.push('- Be concise in chat — the user sees every tool call live in the UI. Do not paste whole files into chat; write them with tools.');
  L.push('- Design matters: by default produce beautiful, modern, polished UIs with good typography, spacing and subtle animations.');
  L.push('- User attachments arrive inside <attachment> tags. Archives are already extracted (the path is given) — read files from there or unpack into the project with extract_archive.');
  L.push('- Each user message starts with a [MODE: …] tag. In PLAN and ASK modes you must not change anything.');
  if (exp === 'beginner') L.push('- The user is a beginner: explain results in simple words and tell them exactly how to run things.');
  if (exp === 'pro') L.push('- The user is an experienced developer: be brief and technical.');
  if (hints.length && !compact) {
    L.push('');
    L.push('# Preferred stacks for this user');
    for (const h of hints) L.push(`- ${h}`);
  }
  if (memory) {
    L.push('');
    L.push('# Project memory (instructions saved for this project)');
    L.push(memory.slice(0, compact ? 4000 : 20000));
  }
  if (s.customInstructions?.trim()) {
    L.push('');
    L.push("# User's custom instructions");
    L.push(s.customInstructions.trim().slice(0, 8000));
  }
  return L.join('\n');
}

export function heuristicTitle(text: string, lang: 'pl' | 'en') {
  let t = text.replace(/\s+/g, ' ').trim();
  t = t.replace(/^(siemka|siema|hejka|hej|cześć|czesc|witam|witaj|elo|yo|hi|hello|hey|dzień dobry)[\s,!.]+/i, '');
  t = t.replace(/^(proszę|prosze|please|pls|plz)[\s,]+/i, '');
  t = t.replace(/^(\[[^\]]*\]\s*)+/, '');
  const m = t.match(/^(.{6,80}?[.!?])(\s|$)/);
  if (m) t = m[1];
  if (t.length > 58) t = t.slice(0, 58).replace(/\s+\S*$/, '') + '…';
  t = t.replace(/[.!?,;:]+$/, '').trim();
  if (!t) return lang === 'pl' ? 'Nowy czat' : 'New chat';
  return t.charAt(0).toUpperCase() + t.slice(1);
}
