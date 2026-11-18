type LanguageDefinition = { extensions: string[]; aliases?: string[]; names?: string[] };

// Pure filename/alias data: file readers must not load Markdown or the highlighter.
const definitions = {
  text: {
    extensions: ['txt', 'text', 'log', 'csv', 'tsv', 'rst', 'rest'],
    aliases: ['plaintext', 'plain', 'none', 'nohighlight'],
    names: ['readme', 'license', 'licence', 'copying', 'copyright', 'notice', 'authors', 'changelog', 'changes', 'news', 'todo', 'install', '.gitignore', '.gitattributes', '.gitkeep', '.gitmessage', '.dockerignore', '.npmignore', '.eslintignore', '.prettierignore', '.ignore'],
  },
  lua: { extensions: ['lua', 'luau'], aliases: ['pluto'] },
  javascript: { extensions: ['js', 'jsx', 'mjs', 'cjs'] },
  typescript: { extensions: ['ts', 'tsx', 'mts', 'cts'] },
  python: { extensions: ['py', 'pyw', 'pyi'], aliases: ['gyp', 'ipython'] },
  bash: {
    extensions: ['sh', 'bash', 'zsh', 'ksh'], aliases: ['shell'],
    names: ['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.kshrc', '.shrc', '.envrc'],
  },
  powershell: { extensions: ['ps1', 'psm1', 'psd1', 'pssc', 'psrc'], aliases: ['pwsh', 'ps'] },
  dos: { extensions: ['bat', 'cmd'], aliases: ['batch'] },
  c: { extensions: ['c', 'h'] },
  cpp: { extensions: ['cc', 'cpp', 'cxx', 'c++', 'hh', 'hpp', 'hxx', 'h++', 'ipp', 'inl', 'tpp'] },
  csharp: { extensions: ['cs', 'csx'], aliases: ['c#'] },
  java: { extensions: ['java'], aliases: ['jsp'] },
  kotlin: { extensions: ['kt', 'kts'], aliases: ['ktm', 'ktx'] },
  swift: { extensions: ['swift'] },
  go: { extensions: ['go'], aliases: ['golang'] },
  rust: { extensions: ['rs'] },
  ruby: { extensions: ['rb', 'rake', 'gemspec', 'podspec'], aliases: ['thor', 'irb'], names: ['gemfile', 'rakefile', 'guardfile', 'podfile', 'brewfile'] },
  php: { extensions: ['php', 'phtml'] },
  sql: { extensions: ['sql', 'ddl', 'dml'] },
  protobuf: { extensions: ['proto'] },
  json: { extensions: ['json', 'jsonc', 'json5', 'code-workspace'], names: ['.prettierrc', '.babelrc', '.eslintrc', '.stylelintrc', '.jshintrc', '.jscsrc', '.bowerrc', '.luarc', 'pipfile.lock'] },
  css: { extensions: ['css'] },
  scss: { extensions: ['scss'] },
  less: { extensions: ['less'] },
  xml: { extensions: ['xml', 'html', 'htm', 'xhtml', 'vue', 'svelte', 'xsd', 'xsl', 'xslt', 'xaml', 'svg', 'plist', 'config', 'resx', 'csproj', 'fsproj', 'vbproj', 'props', 'targets', 'ui', 'qrc', 'ps1xml', 'psc1'], aliases: ['rss', 'atom', 'xjb', 'wsf'] },
  yaml: { extensions: ['yaml', 'yml'], names: ['.clang-format', '.clang-tidy'] },
  ini: { extensions: ['ini', 'toml', 'cfg', 'conf', 'env', 'service', 'socket', 'timer', 'desktop'], names: ['.env', '.editorconfig', '.gitconfig', '.gitmodules', '.npmrc', '.yarnrc', '.pypirc', '.coveragerc', 'pipfile', 'cargo.lock', 'poetry.lock', 'uv.lock'] },
  properties: { extensions: ['properties'] },
  nginx: { extensions: [], aliases: ['nginxconf'], names: ['nginx.conf'] },
  apache: { extensions: [], aliases: ['apacheconf'], names: ['httpd.conf', 'apache2.conf', '.htaccess'] },
  cmake: { extensions: ['cmake'], aliases: ['cmake.in'], names: ['cmakelists.txt'] },
  dockerfile: { extensions: ['dockerfile', 'containerfile'], aliases: ['docker'], names: ['dockerfile', 'containerfile'] },
  makefile: { extensions: ['mk', 'mak'], aliases: ['make'], names: ['makefile', 'gnumakefile', 'bsdmakefile'] },
  diff: { extensions: ['diff', 'patch'] },
  markdown: { extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdown'] },
  asciidoc: { extensions: ['adoc', 'asciidoc'] },
  latex: { extensions: ['tex', 'sty', 'cls'] },
} satisfies Record<string, LanguageDefinition>;

export type CodeLanguage = keyof typeof definitions;
export type CodeFileFormat = { language: CodeLanguage; kind: 'text' | 'markdown' | 'json' };

const extensions = new Map<string, CodeLanguage>();
const names = new Map<string, CodeLanguage>();
const aliases = new Map<string, CodeLanguage>();
for (const [language, value] of Object.entries(definitions)) {
  const definition: LanguageDefinition = value;
  const canonical = language as CodeLanguage;
  for (const extension of definition.extensions) extensions.set(extension, canonical);
  for (const name of definition.names ?? []) names.set(name, canonical);
  for (const alias of [language, ...definition.extensions, ...(definition.aliases ?? [])]) aliases.set(alias, canonical);
}

/** Explicit text allowlist; an arbitrary extensionless file is still a download. */
export function fileCodeFormat(path: string): CodeFileFormat | null {
  const name = path.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const lower = name.toLowerCase();
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  let language = names.get(lower);
  // Recognize conventional dotenv variants without accepting .env.exe or .env.unknown.
  if (!language && /^\.env\.(?:local|dev|development|test|testing|prod|production|stage|staging|ci|example|sample|template|default)(?:\.local)?$/.test(lower)) language = 'ini';
  // Uppercase .C/.H conventionally denote C++; all other extensions ignore case.
  language ??= extension === 'C' || extension === 'H' ? 'cpp' : extensions.get(extension.toLowerCase());
  if (!language) return null;
  return { language, kind: language === 'markdown' ? 'markdown' : language === 'json' && extension.toLowerCase() === 'json' ? 'json' : 'text' };
}

export function codeLanguage(path: string): CodeLanguage {
  return fileCodeFormat(path)?.language ?? 'text';
}

/** Markdown fence info and source readers resolve through the same aliases. */
export function highlightLanguage(info: string): CodeLanguage | null {
  return aliases.get(info.trim().split(/\s+/)[0]?.toLowerCase() ?? '') ?? null;
}
