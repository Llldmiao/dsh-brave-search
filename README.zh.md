# Brave 搜索 — DeepSeek Harness 插件

[English](README.md) | 中文

这是一个 Host 侧 bundle，把官方的 [Brave Search API skills](https://github.com/brave/brave-search-skills)（`curl` + `SKILL.md` 的说明式玩法）转成一等公民的 Harness 工具。模型不再需要先读 skill 再拼 `curl`，而是直接调用带类型定义的工具体，拿回紧凑、按 token 预算裁剪过的文本。

由 `brave-search-skills` v1.5.0 转换而来（原 `skills/` 目录含 11 个 HTTP 接口，外加 `bx` CLI skill）。

## 工具

| 工具 | 对应 Brave 接口 | 适用场景 |
|---|---|---|
| `brave_search` | `/res/v1/web/search`、`/res/v1/news/search`、`/res/v1/images/search`、`/res/v1/videos/search` | 带标题、URL、摘要的排序结果；用 `type` 选择索引 |
| `brave_llm_context` | `/res/v1/llm/context` | 已抽取好的网页正文，按 token 预算裁剪——做 grounding 用这个 |
| `brave_answers` | `/res/v1/chat/completions` | 带引用的 AI 汇总答案；`research: true` 走较慢的多轮搜索模式 |
| `brave_local` | `/res/v1/local/place_search`、`/res/v1/local/pois`、`/res/v1/local/descriptions` | 按查询词/地点/坐标找商户与地点、POI 详情、AI 生成的地点描述 |
| `brave_query` | `/res/v1/suggest/search`、`/res/v1/spellcheck/search` | 搜索联想词与「你是不是想搜」纠错 |

除了这些工具，插件还会往 `ctx.web` 注册一个 id 为 `brave` 的搜索 provider（走 `/res/v1/web/search`），让 Harness 内置的 `web_search` 也能跑在 Brave 上——见[把 Brave 设为默认 `web_search` provider](#把-brave-设为默认-web_search-provider)。

每个工具都返回 `{ endpoint, query, count, text, … }`；`text` 是模型读的渲染块，其余字段留给程序化调用方（PTC 模式）使用。

各接口的能力按官方文档逐路由校验：`offset` 只发给 web/news/videos，`goggles` 不发给 images/videos，`freshness` 不发给 images，`extra_snippets` 只给 web/news，`result_filter` 只给 web，而 images 的 `safesearch=moderate` 会直接在本地被拒，避免发出去后吃一个 422。

## 前置条件

- DeepSeek Harness Desktop（在 `0.2.1-rc.3` 上验证过）。
- 一个 Brave Search API 订阅。到 <https://api.search.brave.com> 申请 key。各接口属于不同套餐：web/news/images/videos/llm-context/pois/descriptions 需要 **Search** 套餐，`place_search` 需要带地点选项的 Search，`suggest` 需要 **Suggest** 套餐，`spellcheck` 需要 **Spellcheck** 套餐，answers 需要 **Answers** 套餐。套餐不匹配时对应工具会返回 HTTP 401/403 并附说明。

## 安装

有两种方式把 bundle 装进 Harness profile。殊途同归：profile 里多一行 `brave-search`，再到**插件**页面打开开关。

### 第一步 — 配好 API key（两种方式都需要）

Harness 启动时会读取 `$DSH_HOME/.env`（默认 `~/.dsh/.env`）并把其中的值注入 `process.env`：

```bash
printf 'BRAVE_SEARCH_API_KEY=%s\n' 'your-key' >> ~/.dsh/.env
```

这和 Harness 存放其它网关密钥是同一层，不会跟着代码仓库走。在启动 Harness 的 shell 里 export 也可以，且优先级更高。这个 key 不会被本包或插件 patch 读取。

改完后重启一次 Harness，让新的环境变量生效。

### 方式 A — 从本地 checkout 安装（开发时推荐）

把仓库 clone 到任意目录，然后以 link 方式安装，这样改 `index.js` 后重启 Harness 即可生效：

```bash
git clone https://github.com/Llldmiao/dsh-brave-search.git ~/development/github/dsh-brave-search

"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "link:$HOME/development/github/dsh-brave-search"
```

然后在 Harness 侧边栏打开**插件**，把 `brave-search` 那一行打开。**选中 bundle 才会写进 profile 的 `dsh.profile.bundles`**，CLI 命令本身只负责装包。

能用 GUI 就优先用 GUI——在**插件**页点「添加插件」，指向 checkout 目录即可。

### 方式 B — 从 npm 安装

发布之后，任何机器都可以按包名安装：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add dsh-plugin-brave-search
```

同样要到**插件**页把 `brave-search` 打开。npm 安装是普通（非 link）包：升级就是再用同样的命令装新版本，然后重启。

### 验证安装

重启后，通过 Harness 发起的搜索应该由 Brave 返回结果。provider 生效时 `web_search` 只返回来源、没有答案正文；`brave_search` 返回渲染好的结果列表。如果那一行显示**异常**，点进详情页，原因写在「原因」那里（参见[排障](#排障)）。

## 配置

插件 patch 行支持以下可选字段（括号里是默认值）：

```yaml
- id: brave-search
  config:
    apiKeyEnv: BRAVE_SEARCH_API_KEY   # 存放 token 的环境变量名
    baseUrl: https://api.search.brave.com
    timeoutMs: 30000                  # 单次调用超时；research 模式允许到 330000
    count: 10                         # 每次调用默认返回条数
```

Brave 自己的默认值是 web/news/videos 各 20 条、images 50 条、place search 20 条。本 bundle 默认取 10，是为了让工具结果别太占上下文；每个工具都暴露了 `count`，模型可以主动要更多。

`baseUrl` 可以带路径前缀（例如 `https://gateway.example/brave`），拼接路由时会保留该前缀。

## 把 Brave 设为默认 `web_search` provider

除了自带工具，插件还会往 Harness 的 web seam（`ctx.web`）注册一个搜索 provider，于是内置的 `web_search` 工具可以跑在 Brave 上而不是别的 provider。provider id 是 `brave`（可用 `config.id` 覆盖）。

web seam 每次调用只选一个 provider：配了 id 且已注册可用就用它；没配 id 时，恰好一个可用 provider 会自动选中，多个可用会抛 `WEB_PROVIDER_AMBIGUOUS`。要让 Brave 成为默认，在 profile patch 里钉住它（bundle 自己的 patch 改不了别的包的配置）：

```yaml
- id: web
  config:
    searchProvider: brave
# 把被替换掉的 provider 卸载；不钉而同时存在两个可用 provider 会直接报错。
- id: web-search-deepseek
  config:
    enabled: false
```

之后 `web_search`（只返回来源、无答案正文）和 `web_fetch`（不变，仍走本地 HTTP provider）都会经过 Brave。provider 的 `available()` 只检查 token 变量是否存在，**从不发网络请求**。

provider 通过 `ctx.inject(['web'], ...)` **惰性挂载**，而不是写进 bundle 顶层的 `inject`。顶层条目是*必需依赖*：在没有 web seam 的部署上，`apply` 一旦碰 `ctx.web`，cordis 会抛 `cannot get property "web" without inject`，整个 bundle 在插件页显示为**异常**，而不是安静地跳过这个 provider。所以 `web` 必须留在顶层清单之外。

如果想两个 provider 都留着，把 DeepSeek 那行保持启用，然后改 `searchProvider`（或环境变量 `DSH_WEB_SEARCH_PROVIDER`）在 `brave` 和 `deepseek-official` 之间切换，两个 id 可以共存。

## 安全说明

- 工具描述会告诉模型：Brave 返回的是外部、不可信数据，不得把其中的内容当作指令执行。内置 `web_search` 也是同一套规则。
- 订阅 token 只会以 `X-Subscription-Token` 头发往配置的 base URL，且不会出现在工具输出里。
- 本目录不存放任何凭据。

## 验证

`test/verify.mjs` 是一个自包含的验证脚本：它加载从已安装 Harness 里抽出来的**真实** `@deepseek-ai/dsh-tools` schema 校验器，把 bundle 注册进一个假 context，然后用本地 mock 的 Brave API 跑一遍所有工具。断言覆盖出站请求（路由、查询参数、请求头、方法、请求体）、解析与渲染后的输出、声明的输出 schema，以及各条错误路径。

```bash
node test/verify.mjs   # OK — 148 assertions passed across 5 tools
```

它依赖一份从已安装 app 抽出来的 Harness 包副本：

```bash
node ../scratch/dsh-plugin/asar-extract.mjs \
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" \
  ../scratch/dsh-plugin/vendor "dsh/node_modules/@deepseek-ai"
```

如果处理后的 vendor 目录不在默认位置，用 `DSH_VENDOR_DIR` 指过去：

```bash
DSH_VENDOR_DIR=../scratch/dsh-plugin/vendor/dsh/node_modules node test/verify.mjs
```

这套脚本**不覆盖**的部分：它不会把 bundle 装进真实 profile，所以激活、Host 注册顺序、插件页清单条目、图标渲染这些只能在装完之后验证；另外构建时没有可用的 API key，因此没有跑真实 Brave 响应，请求结构依据的是官方 API 文档和这个 bundle 转换自的那些 skills。

seam provider 则可以用一个临时 context 做真机验证——不装进 profile 也能打到真实 Brave API：

```bash
set -a; . ~/.dsh/.env; set +a
node --input-type=module -e "
const mod = await import('$PWD/index.js')
const providers = []
mod.apply({ web: { registerSearchProvider: (p) => providers.push(p) }, tools: { register: () => () => {} }, effect: (fn) => fn() }, {})
const [provider] = providers
console.log(provider.id, provider.available())
console.log(await provider.search({ query: '今天北京天气', maxResults: 3 }))
"
```

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件行显示**异常**，「原因」写着 `cannot get property "web" without inject` | bundle 在 `apply` 里直接读了 `ctx.web`。cordis 只允许访问列在插件 `inject` 里的服务属性。 | 不要把 `web` 写进顶层 `inject`——那会让整个 bundle *必需*一个 web seam，在没有它的部署上直接加载失败。改用 `ctx.inject(['web'], cb)` 注册 provider，也就是 `registerAsWebSearchProvider` 的做法。 |
| `web_search` 报 `WEB_PROVIDER_CONFIGURED_MISSING: brave` | profile 钉了 `searchProvider: brave`，但 bundle 被禁用或没加载。 | 到**插件**页把那一行打开；或者去掉钉死的配置，退回自动选择。 |
| `web_search` 报 `WEB_PROVIDER_AMBIGUOUS` | 注册了两个可用 provider 且没有钉死其中一个。 | 钉死一个：在 `web` 行配 `searchProvider: brave`，或禁用另一个 provider。 |
| `brave_search` 返回 HTTP 401/403 | key 缺少该接口需要的套餐（suggest/spellcheck/answers 是独立套餐）。 | 见[前置条件](#前置条件)。 |

## 发布到 npm

包已经是可发布状态：`package.json` 里带 `name`、`license`、`repository`、`files`、`publishConfig.access: public`，且 `files` 只打包运行时需要的部分（`index.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`）——验证脚本和 README 不进 tarball。

```bash
npm publish --registry=https://registry.npmjs.org --dry-run   # 先看 tarball 内容
npm publish --registry=https://registry.npmjs.org
```

注意事项：

- 包名无 scope，叫 `dsh-plugin-brave-search`，直接发布到公共源即可，不需要任何 scope 配置。带 scope 的名字（`@name/...`）要求存在一个**名字完全一致**的组织；npm 用户名会被规范成小写、账号是 `llldmiao`，所以 `@lldmiao/...` 解析不到，会报 `E404 Scope not found`。
- 无 scope 的名字在公共源上是**先到先得**，发布时必须仍然没人占。
- 仓库推送并打 tag 之后才算正式发布，例如 `git tag v1.0.0 && git push --tags`。`package.json` 的 `version` 要和 tag 对齐。
- `index.js` 没有任何依赖，所以没有需要打包的依赖树，tarball 里也没有 `node_modules`。

## 目录结构

```text
dsh-brave-search/
├── index.js            # Host 侧：工具定义、Brave 客户端、web seam provider
├── package.json        # bundle 清单（dsh.bundle.patch）+ npm 元信息
├── cordis.patch.yml    # 插入 `brave-search` 那一行
├── locale/en.json      # 插件管理器的标题/描述
├── locale/zh.json
├── icon.svg            # 插件行的原创图标
├── LICENSE
└── test/verify.mjs     # 本地验证脚本
```

`index.js` 不 import 任何东西。工具定义就是普通的注册对象（和 `defineTool` 产出的形状一致），所以 link 安装不需要依赖树，也能跨 Harness 升级继续加载。将来如果 Harness 改了工具定义契约，只需要动这一个文件。
