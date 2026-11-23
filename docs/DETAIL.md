# NikoAPI

Connect NikoAPI (New API relay) model Keys to DeepSeek Harness. Settings entry: **Settings → NikoAPI**.

## Features

- **Keys and groups:** list the user's Keys with the management token, select multiple Keys, view masked quota metadata, and edit a Key's remote group where `api_key:write` is granted. Settings entry reads the last cached Key directory. **Refresh**, connecting an account, and confirming a Key selection can fetch the remote Key directory; simply opening Settings does not. The last synchronization time is shown with cached rows.
- **Models:** preview each selected Key's available model catalog, explicitly select models, and confirm the exact provider routes. Same model IDs under different Keys remain separate routes and credentials.
- **Automatic cost-meter calculator:** when the supported cost-meter 1.9.78 Host service is available, NikoAPI registers synchronous price calculators for already-confirmed models whose Key is enabled and whose exact provider route passed readback. No opt-in checkbox is required. Model refresh and confirmation refresh the cached calculator rates. The periodic refresh updates model/rate data, not the Key directory.

## Compatibility limitation

All generated provider routes currently use `openai-completions`. Native protocol adaptation for OpenAI Responses, Anthropic Messages, and Google Generative AI is not implemented. Do not assume GPT, Claude, or Gemini models will use their native DSH protocol. This needs to be resolved and tested before a general release.

## Credentials and permissions

| Purpose | Credential | Required permission |
| --- | --- | --- |
| List Keys and groups | Management token | `api_key:read` |
| Reveal a selected model Key | Management token | `api_key:reveal` |
| Change a remote Key group | Management token | `api_key:write` |
| Read a selected Key's model catalog and usage metadata | That model Key | The Key itself |

The management token and model Keys are kept in DSH's credential store as `NIKOAPI_MANAGEMENT_TOKEN` and `NIKOAPI_API_KEY_<Key ID>`. The UI does not reveal them. Without `api_key:write`, group selection is read-only; viewing and connecting models still work.

## Price calculation

Prices are normalized from NikoAPI's `/api/pricing`; currency and quota units come from `/api/status`.

- Token pricing uses NikoAPI's model and group ratios, completion ratio, cache-read ratio, and cache-write ratio. Missing multipliers are not replaced with `1`.
- Tiered expressions are evaluated by the bounded local expression interpreter using the request's token usage and timestamp. Unsupported expressions remain unavailable to the Niko calculator.
- Per-request pricing returns a total quote without a fabricated token-bucket allocation. Official cost-meter excludes its separate web-request fees from model calculators.
- Auto-group prices are not treated as authoritative where the actual group is unresolved. Only exact, confirmed Key/model pairs receive Niko calculator registrations.
- If a refresh fails, a previously validated price snapshot can remain active for the same Key/group identity, with an incomplete-refresh status. A successfully removed model or a changed Key/group identity invalidates the affected snapshot.
- The quote adapter follows the official cost-meter 1.9.78 contract: synchronous callback, `USD`/`CNY`/`EUR`, total, and—when token buckets are actually known—a five-field breakdown for input, output, cache read, cache write, and reasoning. Reasoning already included in Niko's output count is not charged twice.
- `null` or invalid Niko quotes fall back to cost-meter's normal existing price matching. Therefore an unavailable Niko quote does not guarantee the final cost-meter row is unpriced if another configured price matches.

## Automatic registration and ownership

- NikoAPI does not write `dsh-cost-meter` price tables, balance sources, `customBalances`, recorded usage, or historical ledger amounts. It uses the supported Host-only `registerPriceCalculator({ provider, model, calculate })` API and disposes registrations as the service or exact model route becomes unavailable.
- Existing manual cost-meter prices and calculator owners are preserved at synchronization checks. Cost-meter 1.9.78 exposes no side-effect-free public price-config getter or event for its internal price config, so changes there are observed on a later Niko synchronization pass, not necessarily immediately. The available `getLocalState()` reader starts cost-meter's own background balance refresh; Niko calls it only during synchronization, never on Settings entry or inside a quote callback.
- The calculator callback itself is local and synchronous: it reads only the latest bounded in-memory price snapshot and validated route state; it performs no network request.
- The Key list is not fetched when Settings opens. The user can explicitly refresh it; periodic model/rate refresh does not enumerate the Key directory.

## Provider routes

After explicit model confirmation, NikoAPI creates one `openai-completions` route per Key (`nikoapi-<Key ID>`, base URL `<site>/v1`, credential reference `NIKOAPI_API_KEY_<Key ID>`). It uses settings revision/CAS and reads back route, credential reference, protocol, endpoint, and exact model IDs. Cleanup only removes routes recorded as owned by this plugin; similar unowned provider IDs are not touched. Group changes preserve the user's model choices, refresh that Key's pricing identity, and update its existing routes without selecting additional models.

## State and validation boundaries

The plugin stores bounded masked Key metadata, confirmed model IDs, and price snapshots under `$DSH_HOME/storages/dsh-nikoapi/state.json`. Raw credentials remain in DSH's credential store. Version remains `0.1.0`.

Local synthetic verification covers core security/state/route/pricing regressions, model-capability handling, calculator lifecycle, cache-only Settings entry, restart registration, manual-price conflicts, service disposal/recovery, removed models, and the installed 1.9.78 calculator contract. It uses a temporary DSH_HOME and mock NikoAPI; it does not validate a real Profile install, live credentials, real upstream account charges, paid inference, or visual Settings rendering.
