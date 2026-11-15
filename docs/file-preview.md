# 文件阅读器与格式清单

会话里的文件链接直接打开阅读器，项目文件浏览使用同一份界面。支持文本和 PDF，无需保存到系统下载目录即可查看。脚本只作为源码显示，不执行；HTML 消息卡片仍可使用已有的隔离网页预览，文件阅读器显示 HTML 源码。

源码提供语言高亮、行号、可选择文字、横向滚动、复制和可选下载。输入关键词后高亮匹配位置，并显示当前位置与匹配数量；上／下按钮循环跳转，搜索框回车跳到下一处，可切换区分大小写或清空搜索。搜索是本地字面匹配，不把关键词当正则表达式，也不会重新请求文件。最多定位前 10,000 处匹配，达到上限时提示缩小搜索范围。

Markdown 默认显示标题、列表、表格和代码块排版；「源码与搜索」切换到带行号的源码。项目内容搜索命中某一行后会直接显示源码并定位该行。文件更改面板的「当前源码」也有相同的内容搜索。

## 可直接阅读的格式

扩展名通常不区分大小写，`.C`／`.H` 按惯例使用 C++ 高亮。文件识别与代码块围栏共用 `packages/client-shared/src/code-languages.ts`，未知语言围栏显示纯文本。

| 类型 | 扩展名或文件名 | 显示方式 |
| --- | --- | --- |
| Lua / Luau | `.lua`、`.luau` | Lua 高亮，包含常见 Luau 关键字 |
| JavaScript | `.js`、`.jsx`、`.mjs`、`.cjs` | JavaScript 高亮 |
| TypeScript | `.ts`、`.tsx`、`.mts`、`.cts` | TypeScript 高亮 |
| Python | `.py`、`.pyw`、`.pyi` | Python 高亮 |
| Shell | `.sh`、`.bash`、`.zsh`、`.ksh` | Bash 高亮 |
| PowerShell | `.ps1`、`.psm1`、`.psd1`、`.pssc`、`.psrc` | PowerShell 高亮 |
| Windows 批处理 | `.bat`、`.cmd` | DOS / Batch 高亮 |
| C | `.c`、`.h` | C 高亮 |
| C++ | `.C`、`.H`、`.cc`、`.cpp`、`.cxx`、`.c++`、`.hh`、`.hpp`、`.hxx`、`.h++`、`.ipp`、`.inl`、`.tpp` | C++ 高亮 |
| C# | `.cs`、`.csx` | C# 高亮 |
| Java | `.java` | Java 高亮 |
| Kotlin | `.kt`、`.kts` | Kotlin 高亮 |
| Swift | `.swift` | Swift 高亮 |
| Go | `.go` | Go 高亮 |
| Rust | `.rs` | Rust 高亮 |
| Ruby | `.rb`、`.rake`、`.gemspec`、`.podspec`；Gemfile、Rakefile、Guardfile、Podfile、Brewfile | Ruby 高亮 |
| PHP | `.php`、`.phtml` | PHP 高亮 |
| SQL | `.sql`、`.ddl`、`.dml` | SQL 高亮 |
| JSON / JSONC / JSON5 | `.json`、`.jsonc`、`.json5`、`.code-workspace` | JSON 语法高亮，保留原文与注释 |
| HTML / XML | `.html`、`.htm`、`.xhtml`、`.xml`、`.xsd`、`.xsl`、`.xslt` | XML / HTML 高亮 |
| Vue / Svelte | `.vue`、`.svelte` | XML / HTML 基础语法高亮 |
| XML 工程与资源 | `.xaml`、`.svg`、`.plist`、`.config`、`.resx`、`.csproj`、`.fsproj`、`.vbproj`、`.props`、`.targets`、`.ui`、`.qrc`、`.ps1xml`、`.psc1` | XML 高亮；SVG 链接沿用已有图片阅读器 |
| 样式 | `.css`、`.scss`、`.less` | 对应 CSS / SCSS / Less 高亮 |
| YAML | `.yaml`、`.yml`；`.clang-format`、`.clang-tidy` | YAML 高亮 |
| TOML / INI / ENV | `.toml`、`.ini`、`.cfg`、`.conf`、`.env`、`.service`、`.socket`、`.timer`、`.desktop` | INI / TOML 基础语法高亮 |
| Properties | `.properties` | Properties 高亮 |
| Nginx / Apache | nginx.conf、httpd.conf、apache2.conf、`.htaccess` | 对应 Nginx / Apache 高亮 |
| Docker | Dockerfile、Containerfile、`.dockerfile`、`.containerfile` | Dockerfile 高亮 |
| Make | Makefile、GNUmakefile、BSDmakefile、`.mk`、`.mak` | Makefile 高亮 |
| CMake | CMakeLists.txt、`.cmake` | CMake 高亮 |
| 差异补丁 | `.diff`、`.patch` | Diff 高亮 |
| Markdown | `.md`、`.markdown`、`.mdown`、`.mkd`、`.mkdown` | 排版预览及可搜索源码 |
| AsciiDoc | `.adoc`、`.asciidoc` | AsciiDoc 源码高亮 |
| LaTeX | `.tex`、`.sty`、`.cls` | LaTeX 源码高亮 |
| 普通文本、日志与表格文本 | `.txt`、`.text`、`.log`、`.csv`、`.tsv`、`.rst`、`.rest` | 纯文本、行号与搜索 |

## 常见点文件与无扩展文件

以下名称也可直接阅读，按文件名匹配，目录名中包含扩展名不会影响识别：

- 文本说明：README、LICENSE、LICENCE、COPYING、COPYRIGHT、NOTICE、AUTHORS、CHANGELOG、CHANGES、NEWS、TODO、INSTALL。
- 忽略与 Git 文本：`.gitignore`、`.gitattributes`、`.gitkeep`、`.gitmessage`、`.dockerignore`、`.npmignore`、`.eslintignore`、`.prettierignore`、`.ignore`。
- Shell 配置：`.bashrc`、`.bash_profile`、`.bash_login`、`.bash_logout`、`.profile`、`.zshrc`、`.zprofile`、`.zshenv`、`.zlogin`、`.zlogout`、`.kshrc`、`.shrc`、`.envrc`。
- JSON 配置：`.prettierrc`、`.babelrc`、`.eslintrc`、`.stylelintrc`、`.jshintrc`、`.jscsrc`、`.bowerrc`、`.luarc`、Pipfile.lock。
- INI / TOML 配置：`.env`、`.editorconfig`、`.gitconfig`、`.gitmodules`、`.npmrc`、`.yarnrc`、`.pypirc`、`.coveragerc`、Pipfile、Cargo.lock、poetry.lock、uv.lock。
- Dotenv 变体：`.env.local`、`.env.dev`、`.env.development`、`.env.test`、`.env.testing`、`.env.prod`、`.env.production`、`.env.stage`、`.env.staging`、`.env.ci`、`.env.example`、`.env.sample`、`.env.template`、`.env.default`，以及这些名称之后再加 `.local` 的形式。

## 其他类型与限制

二进制文档和已有媒体格式：

| 类型 | 扩展名 | 显示方式 |
| --- | --- | --- |
| PDF | `.pdf` | 分页、跳页、适宽、缩放、可选文字、全文搜索与匹配跳转 |
| 图片 | `.png`、`.jpg`、`.jpeg`、`.jpe`、`.webp`、`.gif`、`.bmp`、`.ico`、`.avif`、`.svg` | 图片阅读器，具体解码能力取决于平台 |
| 音频 | `.mp3`、`.wav`、`.wave`、`.m4a`、`.m4b`、`.aac`、`.ogg`、`.oga`、`.opus`、`.flac`、`.aif`、`.aiff`、`.webm` | 已有音频播放器，具体编码支持取决于平台 |

PDF 使用随服务器交付的 PDF.js，页面渲染、缩放、文字选择和全文搜索全部在客户端浏览器／隔离 WebView 内完成。服务器只提供静态阅读器资源和已有的鉴权文件传输，不转换、不解析文档，不新增常驻进程或临时转换文件。静态资源不进入 APK／IPA／原生 Control 安装包，打开 PDF 时按需从同一个 Relay 加载，不使用第三方服务。

PDF 支持区分大小写、上下匹配跳转和最多 10,000 处定位。扫描 PDF 没有文字层时只能查看页面，不包含 OCR；加密或损坏的 PDF 会明确提示并保留下载原件。Word（DOC／DOCX）、Excel（XLS／XLSX）、PowerPoint（PPT／PPTX）、ODF（ODT／ODS／ODP）及 RTF 保留下载，不安装 LibreOffice，也不提供服务器转换。

压缩包、可执行文件、编译后的 Lua（`.luac`）和未知格式仍保留下载入口。RST、AsciiDoc、LaTeX 和 CSV / TSV 为源码阅读，不转换成 PDF 或电子表格。

文本及文档预览沿用后台「系统设置 → 文件预览」的大小上限，默认 32 MiB；未知旧服务器回退为 2 MiB。PDF 与文本都使用原有文件接口的 `preview=1` 再次校验服务器当前上限。非法 UTF-8 或含 NUL 的文本文件提示下载原文件，不把二进制误渲染为代码。大文本按可见行高亮、分行虚拟滚动；超出整篇高亮预算时，多行字符串和注释的跨行语法颜色可能不完整，原文与搜索仍保留。

这份共享界面覆盖 Web、iOS、Android 和原生 Control。Web 需发布包含新界面的服务器；已安装的原生客户端需重建并更新，源码或 Web 构建通过不代表原生安装包或 iOS 实机已验收。

验证入口：`tests/code-languages.test.ts`、`tests/source-search.test.ts`、`tests/source-reader.test.ts`、`tests/mobile-project-browser.test.ts`、`tests/document-preview.test.ts`、`tests/document-reader.test.ts` 和 `tests/files-relay.test.ts`。
