# dsh-nikoapi

连接 NikoAPI（New API 中转）模型 Key 与 DeepSeek Harness。

## 功能

- 连接 NikoAPI 账号，管理多个模型 Key 和分组。
- 在设置页使用缓存的 Key 信息，并按需刷新远端 Key 列表。
- 预览所选 Key 的模型，只接入用户明确确认的模型。
- 每个 Key 建立独立 Provider 路由；相同模型 ID 仍使用各自的凭据。
- 在管理令牌具备相应权限时，修改 Key 的远端分组。
- 检测到 `dsh-cost-meter` 1.9.78 或更高版本后，为已确认、Key 启用且路由验证通过的模型自动注册价格计算器。
- 模型更新及定时刷新时更新计算器价格，不定时重新加载 Key 列表。
- 凭据保存在 DSH 凭据库中；界面中的 Key 信息为脱敏显示。
- 通过 cost-meter Host API 注册计算器，不修改其价格配置、余额或已记录的账单。

当前生成的 Provider 路由使用 `openai-completions`。
