# Discord Self-Bot Grinder Engine

> ⚠️ **FOR EDUCATIONAL PURPOSES ONLY - USE AT YOUR OWN RISK.** This project is shared strictly for learning and research. It drives *user accounts* with `discord.js-selfbot-v13`. Automating user accounts ("self-botting") **violates [Discord's Terms of Service](https://discord.com/terms)** and can also break the rules of the bots and servers you use it in. Using it can lead to **warnings, captcha locks, temporary suspensions or permanent account bans**. The author and contributors accept **no responsibility** for any action taken against your accounts, servers or bots. Do not run it on accounts you are not prepared to lose.

---

An engine built with [`discord.js-selfbot-v13`](https://github.com/aiko-chan-ai/discord.js-selfbot-v13) and Firebase Realtime Database. It logs into several Discord user accounts at once and runs them in **modes** (auto-catching, channel spamming and two small helper modes). Everything is configured live from Discord through a controller bot, with no restart needed for config changes.

📖 **Every mode, its arguments and its setup steps are documented in [MODES.md](MODES.md).**

## Table of contents

1. [How it works](#how-it-works)
2. [Features](#features)
3. [Requirements](#requirements)
4. [Step 1 - Create the Firebase project](#step-1---create-the-firebase-project)
5. [Step 2 - Set up the engine (this repo)](#step-2---set-up-the-engine-this-repo)
6. [Step 3 - Set up the controller bot (Utilities)](#step-3---set-up-the-controller-bot-utilities)
7. [Step 4 - First configuration from Discord](#step-4---first-configuration-from-discord)
8. [Remote updates](#remote-updates-pull-grinder)
9. [Firebase data layout](#firebase-data-layout)
10. [Environment variables](#environment-variables)
11. [Troubleshooting](#troubleshooting)
12. [Security notes](#security-notes)
13. [File structure](#file-structure)
14. [License](#-license)

---

## How it works

The project is a **controller + engine** pair that talks through one shared Firebase Realtime Database:

```
┌───────────────────────────────────────────┐
│  Discord "Utilities" controller bot       │   You type commands in Discord
│  github.com/Kurtis-Lam/utilities          │   (.grinder, .pause, .resume ...)
└─────────────────────┬─────────────────────┘
                      │ writes config           ▲ writes names, status, alerts
                      ▼                         │
┌───────────────────────────────────────────┐
│       Firebase Realtime Database          │   node: /grinder/...
└─────────────────────┬─────────────────────┘
                      │ real-time sync          ▲
                      ▼                         │
┌───────────────────────────────────────────┐
│  Grinder Engine (this repo)               │   Logs into the accounts and
│  github.com/Kurtis-Lam/self-bot           │   executes the modes
└───────────────────────────────────────────┘
```

1. **Controller bot** - the `grinder` command of [Kurtis-Lam/utilities](https://github.com/Kurtis-Lam/utilities) (owner only). It stores accounts, configs, excludes, detector bots and log channels in Firebase.
2. **Firebase** - the broker between the two programs. Both use the **same project, same database URL and the same service-account key**.
3. **Engine** - this repo. It listens to `/grinder`, logs accounts in or out as they are added or removed, and runs the modes.

## Features

- **Multi-account management** - several tokens run at once; accounts are logged in, logged out and re-logged in automatically as the database changes.
- **Four modes** - `autocatch`, `spam`, `dotcatch`, `commaedit` (see [MODES.md](MODES.md)).
- **Autocatch engine** - reads name predictions from a *detector bot*, supports server/channel targeting, Pokémon names, JSON datafiles and exclude lists, and uses turn-based rotation so two accounts never answer the same spawn.
- **Captcha detection and alerting** - when Pokétwo shows its verification message ("Whoa there"), the flagged account's `autocatch` and `spam` configs are paused in Firebase and an alert with the verification link is posted to your alerts channel. The engine does **not** solve captchas.
- **Pause / resume** - pause forever or for a duration (`pause 40m`), resume forever or for a duration (`resume 10s`), per config or all at once.
- **Success and alert logs** - per-server log channels.
- **Name lookups** - the controller can ask the engine to resolve server and channel names for the config embeds.
- **Self-supervising process** - `index.js` restarts itself with back-off if it crashes.

## Requirements

- [Node.js](https://nodejs.org/) **18 or newer** (LTS recommended) and npm
- [Git](https://git-scm.com/) (needed for remote updates)
- A free [Firebase](https://firebase.google.com/) project with a **Realtime Database**
- [Python](https://www.python.org/) **3.12** and pip, to run the controller bot: [Kurtis-Lam/utilities](https://github.com/Kurtis-Lam/utilities) (Step 3)
- A Discord *bot application* (token) for the controller, created in the [Developer Portal](https://discord.com/developers/applications) (Step 3)
- A Discord *detector bot* that posts predictions like `Galarian Ponyta: 97%` (only needed for `autocatch` and `dotcatch`)

---

## Step 1 - Create the Firebase project

You only do this **once**. The controller and the engine share the result.

1. Open the [Firebase console](https://console.firebase.google.com/) and click **Add project**. Give it any name (for example `grinder`). Google Analytics is not needed.
2. In the left menu open **Build → Realtime Database** and click **Create Database**.
   - Pick the location closest to where you host the engine and the controller.
   - Choose **Start in locked mode**. The engine and the controller connect with the Admin SDK, which bypasses security rules, so locked mode is both enough and the safest choice. Never use "test mode" - your database holds account tokens.
3. Copy the **database URL** shown at the top of the **Data** tab. It looks like one of these:
   ```
   https://<your-db-name>-default-rtdb.firebaseio.com/
   https://<your-db-name>-default-rtdb.<region>.firebasedatabase.app/
   ```
4. Create the credentials file: click the ⚙️ gear next to *Project Overview* → **Project settings** → **Service accounts** tab → **Generate new private key** → **Generate key**. A JSON file is downloaded. **Rename it to `firebase_key.json`.**
5. **Add your database URL to that file.** Open `firebase_key.json` in a text editor and add one extra field, `database_url`, at the end (don't forget the comma after the previous line):

```json
{
  "type": "service_account",
  "project_id": "grinder-12345",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-xxxxx@grinder-12345.iam.gserviceaccount.com",
  "client_id": "...",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "...",
  "universe_domain": "googleapis.com",
  "database_url": "https://grinder-12345-default-rtdb.firebaseio.com/"
}
```

   The engine and the controller both read the database URL from this field, so there is **nothing to edit in the code**. (`databaseURL` is accepted as an alternative field name.)

You now have a single file, `firebase_key.json`, that contains everything both programs need: the credentials **and** the database URL.

> 🔒 `firebase_key.json` gives full admin access to your database. Never commit it, never share it. If it leaks, go back to *Service accounts* and delete/regenerate the key.

## Step 2 - Set up the engine (this repo)

```bash
git clone https://github.com/Kurtis-Lam/self-bot.git
cd self-bot
npm install
```

**2.1 Add the credentials.** Put your `firebase_key.json` (with the `database_url` field from Step 1) in the project root, next to `index.js`. That is all the Firebase configuration the engine needs. If the file or the field is missing, the engine stops at startup and tells you what is wrong.

**2.2 Prepare the data files** (all inside `data/`):

| File | Purpose |
| --- | --- |
| `pokevars.json` | JSON array of known base Pokémon names, used to reduce a detected name (`Galarian Ponyta`) to the name that is actually sent (`ponyta`). A full list is included. |
| `messages.txt` | One message per line, used by `spam` mode. **Replace it with whatever you want** - the file is re-read on every send, so edits apply immediately. |
| `targetcatch/*.json` | *Optional.* Target lists for `autocatch`, for example `data/targetcatch/rares.json` containing `["pikachu", "ponyta"]` or `{ "pokemon": ["pikachu"] }`. |
| `autocatch.json` | Generated automatically. Do not edit. |

**2.3 Turn the folder into a git repository linked to GitHub** (needed for `.pull grinder`). If you used `git clone` in the first step you already have this. If you downloaded a ZIP instead, run:

```bash
git init
git remote add origin https://github.com/Kurtis-Lam/self-bot.git
git fetch origin
git checkout -B main origin/main
```

Or let the updater do it for you by setting the `GRINDER_REPO_URL` environment variable (see [Environment variables](#environment-variables)).

**2.4 Start it:**

```bash
node index.js
```

You should see `=== GRINDER ENGINE SCRIPT LAUNCHING ===` followed by `🔄 Real-time Firebase sync received.`. With no accounts added yet the engine simply waits.

## Step 3 - Set up the controller bot (Utilities)

The engine has no commands of its own: you control it from Discord with the **Utilities** bot ([Kurtis-Lam/utilities](https://github.com/Kurtis-Lam/utilities)). This is what gives you `.grinder`, `.pause` and `.resume` (plus `.pull grinder` for remote updates). "Linking" means running Utilities with **the same Firebase project** as the engine.

**3.1 Create the Discord bot application.** This is a normal bot account (not one of the self-bot accounts).

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Go to **Bot** → **Reset Token** and copy the token. Keep it secret.
3. On the same page, under **Privileged Gateway Intents**, enable **Message Content Intent** and **Server Members Intent**.
4. Go to **OAuth2 → URL Generator**, tick the scopes `bot` and `applications.commands`, give it at least *View Channels*, *Send Messages*, *Embed Links* and *Read Message History*, then open the generated URL and add the bot to your server.
5. Copy your own Discord user ID (Discord → Settings → Advanced → enable **Developer Mode**, then right-click your name → **Copy User ID**). You will need it in step 3.4.

**3.2 Clone and install Utilities** (Python 3.12 recommended)

```bash
git clone https://github.com/Kurtis-Lam/utilities.git
cd utilities
pip install -r requirements.txt
```

(`firebase-admin` is already in its `requirements.txt`.)

**3.3 Give it the same credentials and database URL.** Copy the **same** `firebase_key.json` from Step 1 (including its `database_url` field) into the Utilities folder, **next to `main.py`**. Utilities reads the database URL from this file too, so no code needs to be edited.

The key file used by Utilities and the one used by the engine must belong to the **same** Firebase project and contain the **same** `database_url`.

**3.4 Create `config.json`** next to `main.py`. This is the smallest configuration that runs the grinder commands:

```json
{
  "TOKEN": "your-controller-bot-token",
  "PREFIX": ".",
  "POKETWO_ID": 716390085896962058,
  "OWNER_IDS": [123456789012345678],
  "COGS": {
    "general": ["help", "ping"],
    "owner": ["utils", "grinder", "pull", "reload", "restart", "stats", "gitstats"]
  }
}
```

| Key | What to put |
| --- | --- |
| `TOKEN` | The bot token from step 3.1. |
| `PREFIX` | The command prefix. `.` is the default and is what this guide uses. |
| `POKETWO_ID` | The user ID of the Pokétwo bot. Keep the value above. |
| `OWNER_IDS` | **Your Discord user ID** (a list, so several owners are possible). `.grinder`, `.pause`, `.resume` and `.pull grinder` only work for the IDs listed here. |
| `COGS` | Which features to load. `grinder` provides `.grinder`, `.pause` and `.resume`; `pull` provides `.pull` and `.pull grinder`. Keep them in the `owner` list. |

`MONGO_URI` is optional for this setup: without it Utilities prints a warning and only disables its MongoDB features, which the grinder commands do not use. You can add more cogs from the Utilities README later.

**3.5 Start the controller**

```bash
python main.py
```

The bot should come online in your server. If it stops with an error instead, see [Troubleshooting](#troubleshooting).

**3.6 Test the link.** In a server where the bot is present and your user ID is in `OWNER_IDS`, run:

```
.grinder
```

If the bot answers with the *Mode Configurations* panel, the link works: the controller can read and write the same `/grinder` node the engine is listening to. The three commands you will use every day are:

| Command | What it does |
| --- | --- |
| `.grinder` | Opens the configuration panel (accounts, configs, excludes, detector bots, logs) and adds/removes configs. |
| `.pause [numbers] [time]` | Pauses configs. With no arguments it pauses **all** of them, e.g. `.pause 1 30m` pauses config #1 for 30 minutes. |
| `.resume [numbers] [time]` | Resumes configs. With no arguments it resumes **all** of them. A duration such as `.resume 10s` keeps them running for that long, then pauses them again. |

They are owner-only, work as `.command` or `/command`, and only work inside a server (not in DMs).

## Step 4 - First configuration from Discord

All commands below are owner-only and work as `.command` or `/command` (replace `.` with your prefix). The panel opened by `.grinder` has pages for **Configs, AutoCatch, Excludes, Detector Bots, Logs and Accounts**.

1. **Add accounts** - `.grinder` → **⚙️ Accounts** → **➕ Add Account**, then paste the account's token. Accounts are numbered `#1`, `#2`, ... in the order they are added; tokens are never displayed back, only the account they belong to.
2. **Add a detector bot** *(for `autocatch` / `dotcatch`)* - `.grinder` → **🤖 Detector Bots** → add the user ID of the bot that posts predictions such as `Galarian Ponyta: 97%` or `Possible Pokémon: ponyta`.
3. **Set log channels** - `.grinder` → **📜 Logs** → set **Alerts** (captcha warnings) and **Autocatch** (catch results) channels.
4. **Create your first config:**

   ```
   .grinder add autocatch 1
   .grinder add autocatch 2
   .grinder add spam 1 123456789012345678
   ```

5. **Check it** with `.grinder`, then control it with `.pause`, `.resume` and `.grinder remove <number>`. For example `.pause 1 30m` pauses config #1 for 30 minutes and `.resume` resumes everything.

The full list of modes, arguments and examples is in **[MODES.md](MODES.md)**.

## Remote updates (`.pull grinder`)

`pull.js` (the updater) listens at `grinder_update/request` in Firebase. When you run `.pull grinder` (alias `.pull g`) in Discord, the engine:

1. checks that its folder is a git repository on a branch,
2. runs `git fetch`, then `git pull --ff-only` (or `git reset --hard` with the `hard` option, stashing local changes first otherwise),
3. reinstalls dependencies only if `package.json` / `package-lock.json` changed,
4. reports every step back to Discord through `grinder_update/status`,
5. exits with code `42`, which the built-in supervisor treats as "restart for update".

Options: `.pull grinder force` restarts even if nothing changed, `.pull grinder hard` resets to `origin/<branch>`.

## Firebase data layout

Everything lives under the `grinder` node. You normally never touch it by hand.

| Path | Written by | Content |
| --- | --- | --- |
| `grinder/accounts` | controller | List of account tokens (**sensitive**). The position in the list is the account number. |
| `grinder/configs/<guildId>` | controller / engine | List of mode configs: `mode`, `token`, `accIndex`, `target`, `paused`, `pauseUntil`, `resumeUntil`. |
| `grinder/excludes/<guildId>` | controller | Excluded Pokémon: `{ name, xnon }`. |
| `grinder/detector_bots/<guildId>` | controller | List of detector bot user IDs. |
| `grinder/logs/<guildId>` | controller | `alerts`, `autocatch` → log channel IDs. |
| `grinder/autocatch/pairs`, `grinder/autocatch/current_catcher` | engine | Current rotation pairs and the account that took the last spawn. |
| `grinder/name_requests`, `grinder/id_names` | controller ↔ engine | Server/channel name lookups. |
| `grinder_update/request`, `grinder_update/status` | controller ↔ engine | Remote update handshake. |

## Environment variables

Used by the updater (`pull.js`); all optional.

| Variable | Purpose |
| --- | --- |
| `GRINDER_REPO_DIR` | Folder used for git operations (default: the script folder). |
| `GRINDER_REPO_URL` | Repository URL used to auto-initialise git when the folder is not a repo yet. |
| `GRINDER_REPO_BRANCH` | Branch for the auto-init (default `main`). |

## Troubleshooting

| Problem | Likely cause / fix |
| --- | --- |
| `Could not read firebase_key.json` | The key file is missing or misnamed. It must sit next to `index.js` (and next to `main.py` for the controller). |
| `firebase_key.json has no "database_url" field` | Add `"database_url": "https://<your-db-name>-default-rtdb.firebaseio.com/"` to the key file (see Step 1). |
| The controller exits with `PrivilegedIntentsRequired` | Enable **Message Content Intent** and **Server Members Intent** for the controller bot in the Developer Portal (step 3.1). |
| `❌ Error: 'TOKEN' missing` / `'POKETWO_ID' missing` / `config.json file not found` | `config.json` must sit next to `main.py` and contain at least `TOKEN`, `POKETWO_ID`, `OWNER_IDS` and `COGS` (step 3.4). |
| The controller is online but `.grinder`, `.pause` or `.resume` do nothing or say *for the bot owners only* | Your user ID is not in `OWNER_IDS`, `grinder` is missing from the `owner` list in `COGS`, or you used the command in a DM. Restart the controller after editing `config.json`. |
| `.grinder` shows nothing / Firebase errors in the controller | The controller's `firebase_key.json` (key or `database_url`) does not match the engine's. |
| Engine says `Real-time Firebase sync received` but no account logs in | No accounts added yet, or the token is invalid/expired (`[-] Failed to login Acc #N`). |
| Autocatch does nothing | No detector bot added for that server, the detector's message format is not `Name: 97%`, the Pokémon is excluded, or the account is not in the server. See [MODES.md](MODES.md#autocatch). |
| `.pull grinder` says *Timed out waiting for the grinder update* | The engine is not running, or its folder is not a git repository / does not contain `pull.js`. |
| `Not a git repository (or git missing)` | Follow step 2.3 or set `GRINDER_REPO_URL`. |
| An account stopped catching and spamming by itself | Pokétwo showed it a captcha and the engine paused it. Verify manually, then run `.resume` (and use `.pause` to stop configs again). |

## Security notes

- `grinder/accounts` holds **account tokens in plain text**. Anyone with the Firebase key or database access controls those accounts. Keep the database in locked mode and the key private.
- Add `firebase_key.json`, `data/autocatch.json` and any file containing tokens to `.gitignore`. `firebase_key.json` now also holds your database URL, so keep it out of git as well.
- `backbone.js` is only a minimal example/template with placeholder tokens; do not put real tokens into files that are committed.

## File structure

```text
├── index.js              # Engine entry point + process supervisor
├── pull.js               # Remote updater used by `.pull grinder`
├── backbone.js           # Minimal self-bot template (not used by the engine)
├── firebase_key.json     # Firebase service account key (you create it, never commit it)
├── package.json
├── MODES.md              # Full documentation of every mode
└── data/
    ├── messages.txt      # Spam messages, one per line
    ├── pokevars.json     # Base Pokémon names
    ├── autocatch.json    # Generated: cached active pairs
    └── targetcatch/      # Optional custom target lists (*.json)
```

---

## 📜 License

This application's source code is shared under the **PolyForm Noncommercial License 1.0.0**. 

* **Personal & Educational Use:** Free to use, modify, and explore. You must give credit to the original author.
* **Commercial Use:** If you intend to use this code to earn revenue, build a commercial product, or use it within a business, you **must purchase a commercial license**.

For commercial licensing terms and pricing, please contact me at: `kurtislam100@gmail.com`

---

## 🙌 Acknowledgements

Built with ❤️ by Kurtis.