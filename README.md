# dsh-nikoapi

[简体中文](README.zh-CN.md)

Connect NikoAPI (New API) model Keys to DeepSeek Harness.

## Features

- Connect a NikoAPI account and manage multiple model Keys and groups.
- Cache Key metadata in the Settings page; refresh the remote Key list on demand.
- Preview models for selected Keys and add only models explicitly confirmed by the user.
- Create exactly one provider route per Key, preserving distinct credentials when model IDs overlap.
- Share the protocol set advertised for a NikoAPI group across its confirmed LLM models; auto groups use only protocols common to their candidate groups.
- Change a Key's remote group when the management token has permission.
- Automatically register price calculators for confirmed models with enabled Keys and verified provider routes when `dsh-cost-meter` 1.9.78 or later is available.
- Refresh calculator prices when models are updated and on the configured interval, without periodically reloading the Key directory.
- Keep credentials in DSH's credential store and display Key values in masked form.
- Register calculators through the cost-meter Host API without modifying its price configuration, balances, or recorded ledger entries.

NikoAPI endpoint declarations are aggregated at group level into one shared DSH protocol choice for each Key. The plugin selects one common protocol in priority order `openai-responses`, `anthropic-messages`, `google-generative-ai`, then `openai-completions`. Explicit GPT model IDs always select `openai-responses`, even when the site omits that declaration; this is the only model-ID override. Because a Key has exactly one Provider, that protocol applies to every confirmed model on the same Key. The stable route remains `nikoapi-<Key ID>`; the plugin never splits one Key into multiple Providers. Other model families follow endpoint metadata, with identity-matching prior choice or legacy Chat Completions as the fallback. Routes contain only explicitly confirmed models and are verified by settings readback; old suffixed routes are removed only when recorded as plugin-owned.
