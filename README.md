# dsh-nikoapi

[简体中文](README.zh-CN.md)

Connect NikoAPI (New API) model Keys to DeepSeek Harness.

## Features

- Connect a NikoAPI account and manage multiple model Keys and groups.
- Cache Key metadata in the Settings page; refresh the remote Key list on demand.
- Preview models for selected Keys and add only models explicitly confirmed by the user.
- Create a separate provider route for each Key, preserving distinct credentials when model IDs overlap.
- Change a Key's remote group when the management token has permission.
- Automatically register price calculators for confirmed models with enabled Keys and verified provider routes when `dsh-cost-meter` 1.9.78 or later is available.
- Refresh calculator prices when models are updated and on the configured interval, without periodically reloading the Key directory.
- Keep credentials in DSH's credential store and display Key values in masked form.
- Register calculators through the cost-meter Host API without modifying its price configuration, balances, or recorded ledger entries.

Generated provider routes currently use `openai-completions`.
