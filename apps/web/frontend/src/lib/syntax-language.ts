/** Syntax grammars supported by the Shiki worker. Values are Shiki grammar ids. */
export type SyntaxLanguage =
  | 'javascript'
  | 'jsx'
  | 'typescript'
  | 'tsx'
  | 'json'
  | 'yaml'
  | 'python'
  | 'bash'
  | 'rust'
  | 'go'
  | 'css'
  | 'scss'
  | 'less'
  | 'html'
  | 'xml'
  | 'sql'
  | 'toml'
  | 'c'
  | 'cpp'
  | 'java'
  | 'kotlin'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'dart'
  | 'lua'
  | 'r'
  | 'graphql'
  | 'markdown'
  | 'vue'
  | 'svelte'
  | 'astro'
  | 'dockerfile'
  | 'makefile';

const extensionLanguages: Record<string, SyntaxLanguage> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  rs: 'rust',
  go: 'go',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  sql: 'sql',
  toml: 'toml',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  ruby: 'ruby',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  graphql: 'graphql',
  gql: 'graphql',
  md: 'markdown',
  markdown: 'markdown',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
};

const fenceLanguages: Record<string, SyntaxLanguage> = {
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  typescript: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
  python: 'python',
  sh: 'bash',
  shell: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  sql: 'sql',
  toml: 'toml',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  'c++': 'cpp',
  java: 'java',
  kt: 'kotlin',
  kotlin: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  graphql: 'graphql',
  gql: 'graphql',
  md: 'markdown',
  markdown: 'markdown',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  docker: 'dockerfile',
  dockerfile: 'dockerfile',
  make: 'makefile',
  makefile: 'makefile',
};

function basename(fileName: string): string {
  const normalized = fileName.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** Resolve a filename without content probing. Extensions and special basenames are case-insensitive. */
export function resolveFileSyntaxLanguage(fileName: string): SyntaxLanguage | null {
  const base = basename(fileName).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) {
    return 'dockerfile';
  }
  if (base === 'makefile' || base === 'gnumakefile') {
    return 'makefile';
  }
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return null;
  }
  return extensionLanguages[base.slice(dot + 1)] ?? null;
}

/** Resolve a Markdown fenced-code identifier, accepting `language-*` and common aliases. */
export function resolveFenceSyntaxLanguage(identifier: string): SyntaxLanguage | null {
  const normalized = identifier.trim().toLowerCase();
  const suffix = normalized.startsWith('language-')
    ? normalized.slice('language-'.length)
    : normalized;
  if (suffix === '' || suffix === 'text' || suffix === 'txt' || suffix === 'plaintext') {
    return null;
  }
  return fenceLanguages[suffix] ?? null;
}
