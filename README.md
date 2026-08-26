# dsh-codebuddy-models

把本机已登录的 **CodeBuddy / WorkBuddy（腾讯代码助手）** 订阅作为 **dsh（DeepSeek Harness）** 的原生 provider 接入，启用后 CodeBuddy 模型会直接出现在 dsh 的模型选择器中，可像其它模型一样被 agent 调用。

> 用 TypeScript 实现，不依赖 `codebuddy2openai` 的 Python 转换器：凭据读取、token 刷新、直连后端、SSE 流式全部在这个包里完成。

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
pnpm build          # tsc 编译到 lib/
pnpm test           # node --test 单元测试
node verify.mjs     # 校验 provider + models 在真实 llm runtime 上注册成功
node live-check.mjs # 用本机登录态打一次真实流式请求（需 CodeBuddy 已登录）
```

## 安装到 dsh profile（web GUI）

与 `dsh-matrix` 相同的本地 bundle 方式：

1. 在 `C:\Users\niukl\.dsh\profiles\web\package.json`：
   - `dependencies` 加 `"dsh-codebuddy-models": "link:E:/ai-works/dsh-codebuddy-models"`
   - `dsh.profile.bundles` 加 `"dsh-codebuddy-models"`
2. 在 profile 目录执行 `pnpm install`（自动创建 `node_modules\dsh-codebuddy-models` 符号链接）。
3. 重启/刷新 :3080 GUI，模型选择器中即可看到 `CodeBuddy` 提供方及其模型。

> 模型 provider 目录在进程启动时组成，因此启用/移除该 bundle 后需要刷新/重启 GUI 才生效。

## 配置

`Config` 全部可选，可用 `$DSH_HOME/settings.yaml` 的 `llm-codebuddy:` 节热改（`applies: live`）：

```yaml
llm-codebuddy:
  baseURL: https://copilot.tencent.com   # 后端 origin，会拼接 /v2/chat/completions
  defaultContextWindow: 1000000
  maxTokens: 64000
  streamIdleTimeoutMs: 300000
  models:
    - id: deepseek-v4-flash
      name: DeepSeek-V4-Flash
      contextWindow: 1000000
  retryPolicy:
    mode: normal
    maxRetries: 5
```

## 模型与权限

默认模型目录即桌面端列表；具体账号能用哪些模型由**订阅策略**决定。某模型无权限时后端返回 `11136 / model not allowed by policy`，插件会映射为 `MODEL_NOT_ALLOWED` 错误并给出可读提示（"您暂无该模型的使用权限，请联系管理员。"）。

> 本账号实测可用的模型：`deepseek-v4-pro`、`deepseek-v4-flash`、`auto`。

## 推理能力（reasoning）

CodeBuddy 模型原生返回 `reasoning_content`，适配器为每个模型声明了 `off / low / high / max` 四档推理努力（默认 `high`），并把请求里的 `reasoningEffort` 透传为 `reasoning_effort`。dsh 的 agent 循环默认会带一个 `reasoningEffort`，因此模型**必须**声明 reasoning 能力，否则调用会被 harness 以 `UNSUPPORTED_REASONING_EFFORT` 拒绝（表现为"模型可见但无法使用"）。

## 工具调用（tool_calls）

CodeBuddy 后端的工具调用流式返回有一个特点：真实工具名只在**第一个** tool-call delta 里给出，随后的参数分片里 `function.name` 是**空字符串 `""`**（而非省略）。适配器的 SSE 翻译因此只在该字段**非空**时覆盖工具名，避免把有效名称被空串覆盖 —— 否则 dsh 会报 `unknown tool ""` 且无法路由到真实工具。

## 边界

- **未登录 CodeBuddy**：找不到 auth 文件时模型仍会显示，但请求失败并给出 `MISSING_CREDENTIAL` 提示。
- **token 过期**：自动刷新；刷新失败给出明确 `AUTH` 错误。
- 需要本机已登录 CodeBuddy / WorkBuddy 桌面端。
