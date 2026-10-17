# Grinder Engine (`index.js`)

A Node.js engine that logs into multiple Discord accounts and runs them in different **modes**, all configured live through Firebase Realtime Database (`grinder/...`). The Python bot writes the config; this engine listens and reacts in real time, with no restart needed for config changes.

## How it runs

- **Supervisor**: `index.js` forks itself as a child process (`GRINDER_CHILD=1`). If the child crashes it restarts with backoff (3s, 6s... capped at 30s). Exit code `0` stops for good; exit code `42` means "restart for update" and restarts after 0.5s.
- **Firebase sync**: any change under `grinder` is picked up instantly. Accounts that were added get logged in, removed ones get logged out.
- **Config shape**: configs live at `grinder/configs/<guildId>` as a list. Each entry has `mode`, `target`, `token` (or legacy `accIndex`), and optionally `paused` / `pauseUntil`.
- **Files** (in `data/`): `messages.txt` (spam messages, one per line), `pokevars.json` (list of known base Pokémon names), `autocatch.json` (computed pairs), `targetcatch/*.json` (target datafiles).

## Modes

### `autocatch`
Automatically catches Pokémon when a **detector bot** (registered in `grinder/detector_bots/<guildId>`) posts a name prediction like `Galarian Ponyta: 97%`.

1. The detector message (text + embeds) is cleaned and the Pokémon name extracted. The variant is kept for matching (`galarian ponyta`), but the base name is what gets sent to Poketwo (`ponyta`).
2. Only one detection per channel is handled in a **10 second window**, so duplicate detector messages are ignored.
3. Every active autocatch config is checked:
   - **Excludes** (`grinder/excludes/<guildId>`) skip matching Pokémon. `xnon` excludes match only variants, not the exact name.
   - **Target filter** decides what that account catches (see below).
4. A catcher is chosen by **priority**:
   - **3**: the Pokémon was typed directly in the target (for example `ponyta`)
   - **2**: it came from a `.json` datafile
   - **1**: no filter, so it catches everything. Here, active accounts are paired up and the pair that owns the current slice of the day (Hong Kong time) alternates turns between its two accounts.
   Within a priority level, matching accounts take turns round-robin.
5. The chosen account waits 1.0 to 1.5s, then sends `@Poketwo c <name>`. About 10% of the time it types a typo first and edits it to the correct name 300ms later, to look human.

**Target string** (`target`): comma or semicolon separated, any mix of:
| Token | Meaning |
|---|---|
| all-digit number | guild or channel ID where this account is allowed to catch |
| `name` | exact Pokémon name to catch (`ponyta` will not match `galarian ponyta`) |
| `file.json` | datafile of names (array or `{ "pokemon": [...] }`), looked up in `data/targetcatch/`, then `data/`, then the script folder |

Location rules:
- **No IDs**: the account only catches in its own config's server.
- **IDs include this server/channel**: normal catching, no ping needed.
- **IDs given but none match this location**: the account only catches if it was **pinged** in the detector message.
- A filter that is set but empty/missing matches nothing (it never falls back to "catch everything").

### `spam`
Sends random lines from `data/messages.txt` into a channel once per second.

- `target` must contain a **channel ID** (required).
- All spam configs on the same channel form a group, in config order. Each tick, one account sends and then the next account takes the following tick (x1, then x2, then x3, back to x1), skipping accounts that aren't logged in.
- When a spam config is paused, that account is logged out and back in to instantly clear any queued sends.

### `dotcatch`
Manual helper. When the account itself sends a message that is exactly `.`:

1. It sends `@Poketwo h` to request a hint.
2. When a detector bot replies with `Possible Pokémon: <name>` in that channel, that same account sends `@Poketwo c <name>`.

### `commaedit`
When the account sends a message containing `,`, the engine edits it, replacing every `,` with a `@Poketwo` mention. This is useful for writing Poketwo commands quickly.

## Safety and logging

- **Captcha handling**: if Poketwo says "whoa there" to an account (by mention, or because it just attempted a catch in that channel within 30s), all autocatch and spam configs for that account are **paused indefinitely**. A 🚨 alert with the verify link goes to the guild's `alerts` log channel. Resume it from the Python bot.
- **Pauses**: `paused: true` disables a config. `pauseUntil` (ms timestamp) auto-resumes it; a 1s timer checks for expiry.
- **Success logs**: when Poketwo confirms a catch for an account that just attempted one, a 🎉 message is sent to that mode's log channel (`grinder/logs/<guildId>/<mode>`).
- **Name lookups**: the Python bot can request guild/channel names via `grinder/name_requests`; the engine resolves them using any logged-in account and writes results to `grinder/id_names`.

## Remote updates (`.pull grinder`)

`pull.js` (the updater) listens at `grinder_update/request`. On a request it runs `git fetch` and then `pull --ff-only` (or `reset --hard` with `hard`), reinstalls dependencies if `package.json` changed, reports each step to `grinder_update/status`, then exits with code `42` so the supervisor restarts on the new code.

**Requirement**: the engine's folder must be a git repository (see `GRINDER_REPO_URL` / `GRINDER_REPO_DIR` below).

## Setup

1. Put `firebase_key.json` next to `index.js` (never commit it).
2. `npm install discord.js-selfbot-v13 fs-extra firebase-admin`
3. Add Pokémon base names to `data/pokevars.json`.
4. `node index.js`

| Env var | Purpose |
|---|---|
| `GRINDER_REPO_DIR` | folder used for git operations (default: script folder) |
| `GRINDER_REPO_URL` | repo URL used to auto-initialize git if the folder isn't a repo yet |
| `GRINDER_REPO_BRANCH` | branch for auto-init (default `main`) |