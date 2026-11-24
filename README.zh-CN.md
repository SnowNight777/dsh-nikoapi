# dsh-nikoapi

连接 NikoAPI（New API 中转）模型 Key 与 DeepSeek Harness。

## 功能

- 连接 NikoAPI 账号，管理多个模型 Key 和分组。
- 在设置页使用缓存的 Key 信息，并按需刷新远端 Key 列表。
- 预览所选 Key 的模型，只接入用户明确确认的模型。
- 每个 Key 严格只建立一个 Provider 路由；相同模型 ID 仍使用各自的凭据。
- 同一 NikoAPI 分组内已确认的 LLM 共用该组声明的协议集合；自动分组只采用候选分组共有的协议。
- 在管理令牌具备相应权限时，修改 Key 的远端分组。
- 检测到 `dsh-cost-meter` 1.9.78 或更高版本后，为已确认、Key 启用且路由验证通过的模型自动注册价格计算器。
- 模型更新及定时刷新时更新计算器价格，不定时重新加载 Key 列表。
- 凭据保存在 DSH 凭据库中；界面中的 Key 信息为脱敏显示。
- 通过 cost-meter Host API 注册计算器，不修改其价格配置、余额或已记录的账单。

NikoAPI 端点声明会先按分组汇总，再为每个 Key 选择一个共享的 DSH 协议，优先级为 `openai-responses`、`anthropic-messages`、`google-generative-ai`、`openai-completions`。GPT 模型 ID 固定使用 `openai-responses`，即使站点漏报该声明；这是唯一按模型 ID 覆盖协议的规则。每个 Key 只有一个 Provider，因此该协议会作用于同一 Key 下所有已确认模型。稳定路由仍为 `nikoapi-<Key ID>`，不会把一个 Key 拆成多个 Provider。其他模型按端点元数据选择；元数据缺失或不支持时，优先保留身份一致的既有选择，否则回退到旧版 Chat Completions。路由只包含用户明确确认的模型并通过设置读回校验；历史协议后缀路由只有在插件所有权记录中才会清理。
