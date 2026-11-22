import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

(self as any).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  }
};

const ts = (monaco.languages as any).typescript;
if (ts) {
  const diag = { noSemanticValidation: true, noSyntaxValidation: false, noSuggestionDiagnostics: true };
  ts.typescriptDefaults.setDiagnosticsOptions(diag);
  ts.javascriptDefaults.setDiagnosticsOptions(diag);
  const opts = { allowJs: true, jsx: ts.JsxEmit?.ReactJSX ?? 4, target: ts.ScriptTarget?.ESNext ?? 99, allowNonTsExtensions: true, moduleResolution: 2, esModuleInterop: true };
  ts.typescriptDefaults.setCompilerOptions(opts);
  ts.javascriptDefaults.setCompilerOptions(opts);
}

function defineThemes() {
  const dark: monaco.editor.ITokenThemeRule[] = [
    { token: '', foreground: 'D6D6D6' },
    { token: 'comment', foreground: '5E5E5E', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'FFFFFF', fontStyle: 'bold' },
    { token: 'keyword.control', foreground: 'FFFFFF', fontStyle: 'bold' },
    { token: 'storage', foreground: 'FFFFFF', fontStyle: 'bold' },
    { token: 'string', foreground: 'A3A3A3' },
    { token: 'string.escape', foreground: 'C9C9C9' },
    { token: 'number', foreground: 'CFCFCF' },
    { token: 'regexp', foreground: 'B8B8B8' },
    { token: 'type', foreground: 'EDEDED', fontStyle: 'italic' },
    { token: 'type.identifier', foreground: 'EDEDED', fontStyle: 'italic' },
    { token: 'identifier', foreground: 'D6D6D6' },
    { token: 'delimiter', foreground: '8C8C8C' },
    { token: 'delimiter.bracket', foreground: 'A0A0A0' },
    { token: 'operator', foreground: 'A0A0A0' },
    { token: 'tag', foreground: 'FFFFFF', fontStyle: 'bold' },
    { token: 'metatag', foreground: '9E9E9E' },
    { token: 'attribute.name', foreground: 'BFBFBF', fontStyle: 'italic' },
    { token: 'attribute.value', foreground: '9C9C9C' },
    { token: 'variable', foreground: 'DEDEDE' },
    { token: 'variable.predefined', foreground: 'FFFFFF' },
    { token: 'constant', foreground: 'E0E0E0' },
    { token: 'annotation', foreground: '9E9E9E' },
    { token: 'key', foreground: 'E6E6E6' },
    { token: 'string.key.json', foreground: 'E6E6E6' },
    { token: 'string.value.json', foreground: 'A3A3A3' },
    { token: 'keyword.json', foreground: 'FFFFFF' }
  ];
  monaco.editor.defineTheme('lunarix-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: dark,
    colors: {
      'editor.background': '#0a0a0a',
      'editor.foreground': '#d6d6d6',
      'editorLineNumber.foreground': '#363636',
      'editorLineNumber.activeForeground': '#bdbdbd',
      'editor.lineHighlightBackground': '#111111',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#ffffff2a',
      'editor.inactiveSelectionBackground': '#ffffff16',
      'editor.selectionHighlightBackground': '#ffffff12',
      'editor.wordHighlightBackground': '#ffffff10',
      'editor.findMatchBackground': '#ffffff40',
      'editor.findMatchHighlightBackground': '#ffffff1c',
      'editorCursor.foreground': '#ffffff',
      'editorWhitespace.foreground': '#2a2a2a',
      'editorIndentGuide.background1': '#1a1a1a',
      'editorIndentGuide.activeBackground1': '#3a3a3a',
      'editorBracketMatch.background': '#ffffff14',
      'editorBracketMatch.border': '#ffffff40',
      'editorWidget.background': '#121212',
      'editorWidget.border': '#2a2a2a',
      'editorSuggestWidget.background': '#121212',
      'editorSuggestWidget.border': '#2a2a2a',
      'editorSuggestWidget.selectedBackground': '#ffffff18',
      'editorHoverWidget.background': '#121212',
      'editorHoverWidget.border': '#2a2a2a',
      'editorGutter.background': '#0a0a0a',
      'editorOverviewRuler.border': '#00000000',
      'minimap.background': '#0a0a0a',
      'minimapSlider.background': '#ffffff10',
      'scrollbarSlider.background': '#ffffff14',
      'scrollbarSlider.hoverBackground': '#ffffff24',
      'scrollbarSlider.activeBackground': '#ffffff30',
      'diffEditor.insertedTextBackground': '#ffffff1e',
      'diffEditor.removedTextBackground': '#ffffff0a',
      'diffEditor.insertedLineBackground': '#ffffff0e',
      'diffEditor.removedLineBackground': '#00000000',
      'diffEditorGutter.insertedLineBackground': '#ffffff14',
      'diffEditorGutter.removedLineBackground': '#00000000',
      'editorError.foreground': '#ffffff',
      'editorWarning.foreground': '#9a9a9a',
      'editorInfo.foreground': '#9a9a9a',
      focusBorder: '#ffffff30',
      'input.background': '#0f0f0f',
      'input.border': '#2a2a2a',
      'list.hoverBackground': '#ffffff0d',
      'list.activeSelectionBackground': '#ffffff1a',
      'peekView.border': '#3a3a3a'
    }
  });
  const light: monaco.editor.ITokenThemeRule[] = dark.map((r) => {
    const fg = r.foreground ? 255 - parseInt(r.foreground.slice(0, 2), 16) : 0;
    const hex = Math.max(0, Math.min(255, Math.round(fg * 0.9))).toString(16).padStart(2, '0');
    return { ...r, foreground: (hex + hex + hex).toUpperCase() };
  });
  monaco.editor.defineTheme('lunarix-light', {
    base: 'vs',
    inherit: true,
    rules: light,
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1f1f1f',
      'editorLineNumber.foreground': '#c4c4c4',
      'editorLineNumber.activeForeground': '#333333',
      'editor.lineHighlightBackground': '#f6f6f6',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#00000022',
      'editor.inactiveSelectionBackground': '#00000012',
      'editorCursor.foreground': '#000000',
      'editorIndentGuide.background1': '#efefef',
      'editorIndentGuide.activeBackground1': '#cfcfcf',
      'editorWidget.background': '#fafafa',
      'editorWidget.border': '#e0e0e0',
      'editorSuggestWidget.background': '#fafafa',
      'editorGutter.background': '#ffffff',
      'minimap.background': '#ffffff',
      'diffEditor.insertedTextBackground': '#0000001c',
      'diffEditor.removedTextBackground': '#0000000a',
      'diffEditor.insertedLineBackground': '#0000000c',
      'diffEditor.removedLineBackground': '#00000000',
      'editorError.foreground': '#000000',
      'editorWarning.foreground': '#777777'
    }
  });
}
defineThemes();

const LANGS: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  py: 'python', pyw: 'python', php: 'php', phtml: 'php', cs: 'csharp', csx: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', h: 'cpp', c: 'c',
  java: 'java', kt: 'kotlin', kts: 'kotlin', go: 'go', rs: 'rust', rb: 'ruby', swift: 'swift', dart: 'dart', lua: 'lua', r: 'r', scala: 'scala', pl: 'perl',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html', xml: 'xml', svg: 'xml', xaml: 'xml', csproj: 'xml', css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  json: 'json', jsonc: 'json', webmanifest: 'json', md: 'markdown', mdx: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', env: 'ini',
  sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat', dockerfile: 'dockerfile',
  graphql: 'graphql', gql: 'graphql', sol: 'sol', tf: 'hcl', hcl: 'hcl', vb: 'vb', fs: 'fsharp', clj: 'clojure', ex: 'elixir', exs: 'elixir', pas: 'pascal', m: 'objective-c', tcl: 'tcl', twig: 'twig', liquid: 'liquid', hbs: 'handlebars', razor: 'razor', cshtml: 'razor'
};

export function languageFor(path: string): string {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'shell';
  if (name.startsWith('.env')) return 'ini';
  if (name === '.gitignore' || name === '.npmrc') return 'ini';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return LANGS[ext] || 'plaintext';
}

export { monaco };
