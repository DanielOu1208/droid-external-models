# droid-external-models

An app for using your own model providers in [Factory Droid](https://factory.ai). Add your API keys and tick the models you want. Each provider's list comes live from its own API, so new models show up to choose from without anyone maintaining a list, and no other tools are needed.

This is an independent project, not affiliated with or endorsed by Factory.

## Install

Needs [Bun](https://bun.sh) to build. The result is one standalone file, so Bun isn't needed to run it.

```sh
git clone https://github.com/DanielOu1208/droid-external-models.git
cd droid-external-models
bun install
bun run install-local
```

This puts the `droid-models` command in `~/.local/bin`. If your shell can't find it, add that folder to your `PATH`. To update later, run `git pull` and `bun run install-local` again.

It's been run on macOS only so far.

## Run it

```sh
droid-models
```

Pick a provider, press Enter, and paste your key. The app checks the key with the provider, then lists its models with the newest first. Tick the ones you want with Space and press Esc. Droid reloads by itself, so they show up under Custom Models in `/model`.

If Droid already has models you added by hand, setup lists any that overlap so you don't see them twice. Only exact overlaps come ticked: entries with their own key, headers, parameters or limits don't, and the list says what you'd lose. Anything you remove has its settings repointed to the app's entry, and a backup is saved first.

| Key | Where | What it does |
|---|---|---|
| `↑` `↓` or `j` `k` | Lists | Move |
| `Enter` | Provider list | Open a provider |
| `/` | Either list | Search |
| `s` | Provider list | Update Droid's models now |
| `i` | Provider list | Import keys found on this computer |
| `c` | Provider list | Review models the app didn't add |
| `,` | Provider list | Settings, including the opt-in health check |
| `a` / `d` | Provider | Add or replace the key / remove it |
| `o` | Provider | Open the provider's key page |
| `Space` | Provider | Tick or untick a model |
| `Esc` | Anywhere | Go back |
| `q` | Provider list | Quit |

## How it works

- **Model list:** each provider's own model API, falling back to [models.dev](https://models.dev).
- **Limits and prices:** models.dev, falling back to the provider's own data.
- **Which models:** only the ones you tick. The app never adds or removes a model by itself. A ticked model that a provider stops listing stays until you untick it. Models that can't work in Droid, such as ones without tool calls, aren't offered.
- **Images and other input types:** each model is marked for image support using its host's data, then models.dev across all hosts, then its name. Droid has one setting for this, so PDF, audio and video input can't be configured. Models that only output images, video or speech, and embedding models, are left out.
- **Keys:** saved in `~/.config/droid-models/keys.json`, a file only your account can read. It isn't encrypted. Keys found elsewhere are only sent to their own provider, to check they still work before they're offered for import. Droid's settings hold no keys.
- **Tool fix:** Google's API rejects a standard field (`exclusiveMinimum`) in the tool definitions Droid sends. For Gemini on GMI Cloud, and on Google's own endpoint, requests go through a small local process that removes it. It starts when one of those models is used, stops after 30 idle minutes, and only forwards to providers the app knows. For these models Droid never receives your provider key: it gets a local token that's useless anywhere else, and the process adds the real key to each request. It must first prove it knows a secret only your account can read. If it can't, because something else is on port 47613, that model won't connect. Every other model connects directly, using the key from `droid-models key <provider>`.
- **Daily sync:** optional. It refreshes your ticked models' limits and prices at login and each morning on macOS. Elsewhere, run `droid-models sync` from cron.

## Health check (opt-in)

Some providers list models that are down, retired, or can't work with Droid. If you opt in, each model you tick gets a tiny real request, and models that fail stay out of Droid until they pass. If two copies of the app overlap, only one checks and the other changes nothing that time.

**This costs a little.** Requests run on your computer, with your API keys, and are billed to your provider accounts: usually under 1 cent per model. Newly ticked models are checked once, working ones about once a week, and failing ones at each sync. A model usually takes one request, but a retry after a server error or a test without an image can bring it to three.

It's off unless you turn it on, during setup or in Settings. With it off, and during `sync --dry-run`, no model requests are sent. If a request fails because of your account, such as a rate limit or no credit, the model isn't marked as failing. If several models on a provider all fail, its models are left unchanged.

## Known limitation

This only matters on a computer shared with other user accounts, and only for models going through the local process above. If that process crashes, another account could take its port during the following minute. Droid could then send that account's program your next prompts for those models. It wouldn't get your provider key: the token it would see is useless, and stops working when the real process restarts. Droid has no setting that would let the app rule this out.

## What it changes

It only touches `customModels` in `~/.factory/settings.json`, and only the entries it wrote, unless you remove older models during cleanup. Your other settings are left alone, except that cleanup repoints any setting that used a removed model to its replacement. A rejected key or a provider outage doesn't remove anything you've ticked. If the settings file isn't plain JSON, or models.dev is unreachable, nothing is written. The previous file is saved as `settings.json.droid-models.bak`.

## Providers

33 are built in. z.ai, OpenRouter and GMI Cloud have run with real keys; the rest were built from public data and show "untested" on their screen.

To add another, put it in `customProviders` in `~/.config/droid-models/settings.json`:

```json
{
  "customProviders": [
    {
      "id": "my-provider",
      "label": "My Provider",
      "envNames": ["MY_PROVIDER_API_KEY"],
      "listUrl": "https://api.example.com/v1/models",
      "droidProvider": "generic-chat-completion-api",
      "baseUrl": "https://api.example.com/v1"
    }
  ]
}
```

`droidProvider` is `generic-chat-completion-api`, `anthropic` or `openai`. IDs and labels must be unique and can't match a built-in provider, because saved keys are looked up by ID. IDs can only use letters, numbers, dots, dashes and underscores, can't be a reserved word like `constructor`, and URLs must use https, or http on your own computer. A provider that breaks these rules is skipped, with a message saying why.

Subscription logins aren't supported: Claude, ChatGPT, Copilot, Cursor and Gemini CLI. Anthropic's terms bar other tools from using Claude subscription logins, and the app refuses those tokens. Anthropic and OpenAI API keys work.

## Commands

```sh
droid-models                      # open the app
droid-models status               # providers, keys and models
droid-models sync [--dry-run]     # update Droid's models now
droid-models schedule [--remove]  # turn daily sync on or off (macOS)
droid-models key <provider>       # print a key (Droid uses this)
```

## Development

Needs [Bun](https://bun.sh).

```sh
bun install
bun run dev            # run from source
bun test
bun run build          # standalone binary in dist/
bun run install-local  # build and copy to ~/.local/bin
```

## License

MIT. See [LICENSE](LICENSE).
