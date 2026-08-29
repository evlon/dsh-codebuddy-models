# dsh-codebuddy-models

把本机已登录的 **CodeBuddy / WorkBuddy（腾讯代码助手）** 订阅作为 **dsh（DeepSeek Harness）** 的原生 provider 接入，启用后 CodeBuddy 模型会直接出现在 dsh 的模型选择器中，可像其它模型一样被 agent 调用。

> 用 TypeScript 实现，不依赖 `codebuddy2openai` 的 Python 转换器：凭据读取、token 刷新、直连后端、SSE 流式全部在这个包里完成。
>
> 构建时用 esbuild 把运行期依赖（`@deepseek-ai/dsh-llm`、`dsh-settings`、`schemastery`、`eventsource-parser`）**内联打包进 `lib/index.js`**，发布产物自包含、无外部运行期 import——这样它在 **DeepSeek Harness Desktop 的 `preset-plugins` 目录（没有 node_modules）** 里也能像官方 `dsh-tauri*` 插件一样直接加载。

## 工作原理

```
dsh 模型选择器 ── listProviders() / listModels('codebuddy')
   └─ CodeBuddyAdapter
        ├─ 读取桌面端登录凭据 %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info
        │   （token 临近过期时自动调后端刷新并回写）
        └─ fetch https://copilot.tencent.com/v2/chat/completions  (stream + tools)
             └─ SSE → dsh StreamChunk → 回传 agent
```

- 复用本机桌面端登录态，**不做登录授权、不存密码**。
- 后端本身是标准 OpenAI chat-completions 协议，**function calling / tool_calls** 原生支持。
- 只做文本模型（无图片输入）。

## 结构

| 文件 | 职责 |
| --- | --- |
| `src/credentials.ts` | 定位/解析 auth 文件、构造鉴权 headers、自动刷新 token |
| `src/adapter.ts` | `LlmAdapter` 子类：消息序列化、请求后端、错误映射、模型目录 |
| `src/sse.ts` | SSE 解码（`eventsource-parser`）+ `StreamChunk` 翻译 |
| `src/index.ts` | 插件装配：`name`/`inject`/`Config`/`apply`，注册 provider + adapter + settings 节 |
| `cordis.patch.yml` | dsh bundle 层：插入 `llm-codebuddy` 行 |

## 开发

```bash
pnpm install        # 安装依赖
pnpm build          # tsc 编译到 lib/ + esbuild 打包自包含 lib/index.js
pnpm test           # node --test 单元测试
node verify.mjs     # 校验 provider + models 在真实 llm runtime 上注册成功
node live-check.mjs # 用本机登录态打一次真实流式请求（需 CodeBuddy 已登录）
```

## 安装（推荐：已发布到 npm）

包已发布到 npm，任意 dsh profile 一行命令安装：

```bash
# 安装到默认（当前）profile
dsh plugin --profile <profile名> add dsh-codebuddy-models

# 例如装到 web GUI profile
dsh plugin --profile web add dsh-codebuddy-models
```

`dsh plugin add` 会在 profile 里 `pnpm add` 该包，并**自动**把 `dsh-codebuddy-models` 追加到 `dsh.profile.bundles` 层栈（因为包声明了 `dsh.bundle`）。装完**重启/刷新 GUI** 后，模型选择器中即出现 `CodeBuddy` 提供方及其模型。

> 模型 provider 目录在进程启动时组成，因此启用/移除该 bundle 后需要刷新/重启 GUI 才生效。

前置条件：本机需已登录 **CodeBuddy / WorkBuddy 桌面端**（插件读取其本地登录文件，不做登录授权）。

### 设置页 UI（模型配置）

dsh web 的设置页会多出一个「**CodeBuddy 模型**」区块（本包的 client 半 `lib/client.js` 注册），提供：

- **企业模型目录（自动获取 · 只读）**：实时展示从企业账号拉取到的模型列表（ID / 名称 / 输入输出容量 / 描述），无需手动维护。
- **请求参数**：API 地址、默认上下文窗口 / 最大输出 / 流空闲超时。
- **高级：回退模型目录（models）**：折叠区，仅在自动获取不可用（未登录 / 个人账号 / 网络异常）时生效的手写目录。

保存即写入 `llm-codebuddy` 设置命名空间并即时生效（`applies: live`）。

> 说明：dsh 自带的「模型」设置页只认识 `llm-deepseek` / `llm-pi-ai` 两个命名空间，其它命名空间会显示「其余字段在 settings.yaml 中」的提示；因此本包自带了这个独立设置区块，而不是复用「模型」页内的编辑器。

## 开发模式（本地源码 bundle）

开发/调试本包时，用与 `dsh-matrix` 相同的本地 link 方式：

1. 在 `C:\Users\niukl\.dsh\profiles\web\package.json`：
   - `dependencies` 加 `"dsh-codebuddy-models": "link:E:/ai-works/dsh-codebuddy-models"`
   - `dsh.profile.bundles` 加 `"dsh-codebuddy-models"`
2. 在 profile 目录执行 `pnpm install`（自动创建 `node_modules\dsh-codebuddy-models` 符号链接）。
3. 重启/刷新 :3080 GUI，模型选择器中即可看到 `CodeBuddy` 提供方及其模型。

（或者：在插件仓库目录执行 `dsh plugin --profile web add ./dsh-codebuddy-models`，等价且自动注册。）

## 配置

`Config` 全部可选，可用 `$DSH_HOME/settings.yaml` 的 `llm-codebuddy:` 节热改（`applies: live`）。`models` 是**回退目录**（仅在企业模型自动获取不可用时生效），默认只有 `auto`：

```yaml
llm-codebuddy:
  baseURL: https://copilot.tencent.com   # 后端 origin，会拼接 /v2/chat/completions；留空/省略则用此默认值
  defaultContextWindow: 1000000
  maxTokens: 64000
  streamIdleTimeoutMs: 300000
```

> **注意**：`baseURL` 留空（空字符串）等价于省略，会回退到默认端点 `https://copilot.tencent.com`。不要把企业模型列表里的 `serviceEndpoint`（`https://copilot.tencent.com/v2/openapi/chat/completions`）当作 `baseURL`——那个端点是 OpenAPI 专用（需专门 key），桌面端登录态无法直连，会返回 `11101 unauthorized: request is not from an OpenAPI client`。
  models:
    - id: auto                       # 回退目录：默认仅 auto；可自行添加其它模型 ID
  retryPolicy:
    mode: normal
    maxRetries: 5
```

## 模型与权限

模型目录**自动从企业内置模型接口获取**（`www.codebuddy.cn/console/enterprises/{enterpriseId}/builtin-models`，用桌面端登录态鉴权，10 分钟缓存）：企业账号能看到并启用的模型会自动出现在选择器里，无需维护硬编码列表。**该目录只在运行时获取、不写入 `settings.yaml`**，因此不会污染用户配置；设置页的「CodeBuddy 模型」区块通过 LLM 模型 API **只读展示**这份实时目录。

内置静态目录刻意保持最小（**只有 `auto`**）——`auto` 是唯一几乎必然长期有效的模型；其它模型 ID 仍可直接输入使用（适配器对任意 ID 宽容）。获取失败（未登录 / 非企业账号 / 网络异常）时回退到这份静态目录；此时也可在设置页的「高级：回退模型目录」里手动维护一份目录。

具体账号能用哪些模型由**订阅策略**决定。某模型无权限时后端返回 `11136 / model not allowed by policy`，插件会映射为 `MODEL_NOT_ALLOWED` 错误并给出可读提示（"您暂无该模型的使用权限，请联系管理员。"）。

> 本企业账号实测可用的模型（自动获取）：`deepseek-v4-pro`、`deepseek-v4-flash`、`glm-5.3`、`glm-5.2`、`kimi-k3-2`、`hy4-preview`、`auto` 等 20 个。

## 推理能力（reasoning）

CodeBuddy 模型原生返回 `reasoning_content`，适配器为每个模型声明了 `off / low / high / max` 四档推理努力（默认 `high`），并把请求里的 `reasoningEffort` 透传为 `reasoning_effort`。dsh 的 agent 循环默认会带一个 `reasoningEffort`，因此模型**必须**声明 reasoning 能力，否则调用会被 harness 以 `UNSUPPORTED_REASONING_EFFORT` 拒绝（表现为"模型可见但无法使用"）。

## 工具调用（tool_calls）

CodeBuddy 后端的工具调用流式返回有一个特点：真实工具名只在**第一个** tool-call delta 里给出，随后的参数分片里 `function.name` 是**空字符串 `""`**（而非省略）。适配器的 SSE 翻译因此只在该字段**非空**时覆盖工具名，避免把有效名称被空串覆盖 —— 否则 dsh 会报 `unknown tool ""` 且无法路由到真实工具。

## 边界

- **未登录 CodeBuddy**：找不到 auth 文件时模型仍会显示，但请求失败并给出 `MISSING_CREDENTIAL` 提示。
- **token 过期**：自动刷新；刷新失败给出明确 `AUTH` 错误。
- **企业额度上限（`14012`）**：映射为 harness 规范的 `QUOTA` 错误，**不重试**，直接把「已达到企业为您设置的额度上限，如需调整额度，请联系企业管理员。」提示给用户（HTTP 错误体和流内错误块都会处理）。
- **模型无权限（`11136`）**：映射为 `MODEL_NOT_ALLOWED`，不重试，给出可读提示。
- 需要本机已登录 CodeBuddy / WorkBuddy 桌面端。

## 发布到 npm

通过 GitHub Actions（`.github/workflows/npm-publish.yml`）自动发布：推送 `v*` 标签即触发「构建 → 测试 → `npm publish`」。需在仓库 Secrets 里配好 `NPM_TOKEN`。

```bash
npm version patch   # 或 minor / major —— 自动改版本号 + 打标签
git push && git push --tags   # 触发 Actions 发布
```
