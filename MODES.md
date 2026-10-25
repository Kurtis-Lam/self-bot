# Grinder Engine - Modes (`index.js`)

> ⚠️ **For educational purposes only. Use at your own risk.** Automating user accounts violates Discord's Terms of Service and can get accounts banned.

A Node.js engine that logs into multiple Discord accounts and runs each of them in one or more **modes**. Everything is configured live through Firebase Realtime Database (`grinder/...`): the controller bot ([Kurtis-Lam/utilities](https://github.com/Kurtis-Lam/utilities)) writes the config, the engine listens and reacts in real time, **no restart needed**. For installation and Firebase setup see [README.md](README.md).

## Contents

- [Quick reference](#quick-reference)
- [Core concepts](#core-concepts)
- [Mode: `autocatch`](#autocatch)
- [Mode: `spam`](#spam)
- [Mode: `dotcatch`](#dotcatch)
- [Mode: `commaedit`](#commaedit)
- [Shared settings](#shared-settings) (excludes, detector bots, logs)
- [Controlling configs](#controlling-configs) (add, remove, pause, resume, sync)
- [Safety, captcha and logging](#safety-captcha-and-logging)
- [Data files](#data-files)
- [How the engine runs](#how-the-engine-runs)
- [Troubleshooting](#troubleshooting)

---

## Quick reference

| Mode | What it does | Triggered by | Required argument | Optional arguments | Needs a detector bot |
| --- | --- | --- | --- | --- | --- |
| [`autocatch`](#autocatch) | Catches spawned Pokémon automatically | A detector bot's prediction message | none (defaults to the current server) | server/channel IDs, Pokémon names, `.json` datafiles | ✅ |
| [`spam`](#spam) | Sends random lines from `data/messages.txt` into a channel, once per second | A timer | **Channel ID** | - | ❌ |
| [`dotcatch`](#dotcatch) | Requests a hint and catches the answer when you send `.` | You sending `.` from the account | a channel ID (required by the controller, not used by the engine) | - | ✅ |
| [`commaedit`](#commaedit) | Turns every `,` in your message into a Pokétwo mention | You sending a message with `,` | a channel ID (required by the controller, not used by the engine) | - | ❌ |

All commands in this file are **owner-only** controller commands. They work as prefix commands (`.`) and slash commands (`/`); replace `.` with your prefix.

---

## Core concepts

### Config entries

A config is one entry in the list at `grinder/configs/<guildId>`:

```json
{
  "mode": "autocatch",
  "accIndex": 1,
  "token": "<account token>",
  "target": "123456789012345678, ponyta, rares.json",
  "paused": false,
  "pauseUntil": null,
  "resumeUntil": null
}
```

| Field | Meaning |
| --- | --- |
| `mode` | `autocatch`, `spam`, `dotcatch` or `commaedit` |
| `token` / `accIndex` | The account that runs the config. The controller stores the token; `accIndex` is the account's number (1-based). Old configs that only have `accIndex` are migrated automatically. |
| `target` | Mode arguments as one string (see each mode). |
| `paused` | `true` = the config is ignored. |
| `pauseUntil` | Millisecond timestamp. A paused config is **resumed automatically** when it passes. |
| `resumeUntil` | Millisecond timestamp. An active config is **paused automatically** when it passes. |

### The server a config belongs to

A config belongs to the **server (guild) where it was created** (`grinder/configs/<guildId>`). The `#number` shown by `.grinder` is its position in that server's list.

- `dotcatch` and `commaedit` only react to messages sent **in the server that owns the config**.
- `autocatch` scans the configs of **all** servers (see its targeting rules).
- `spam` sends to the channel ID in `target`, wherever it is.

### Account numbers

Accounts are numbered in the order they were added (`#1`, `#2`, ...). Config commands take that number. Removing an account renumbers the others, and configs whose token no longer exists show as *Removed Acc*.

### Argument format

Arguments are separated by **commas** (`,`) or semicolons. The controller's `add` command takes everything after the account number as the argument string:

```
.grinder add <mode> <account number> <arg1>, <arg2>, <arg3>
```

You can do the same from the panel: `.grinder` → **📋 Configs** → **Add**, which opens a form with the fields *Mode*, *Account Number(s)* (for example `1, 2, 3` to create one config per account) and *Target / Arguments / Channel IDs*. **Edit** opens a form with one field per variable of the selected config.

---

## `autocatch`

Automatically catches Pokémon when a **detector bot** posts a name prediction such as `Galarian Ponyta: 97%`.

### Setup

1. Add at least one account (`.grinder` → **⚙️ Accounts** → **➕ Add Account**).
2. Register the detector bot in the server: `.grinder` → **🤖 Detector Bots** → add its user ID (an ID or an @mention).
3. *(Recommended)* set an **Autocatch** log channel and an **Alerts** log channel (**📜 Logs**).
4. Make sure `data/pokevars.json` contains the base Pokémon names.
5. Add the config:

```
.grinder add autocatch <account number> [target]
```

If you give no server/channel ID the controller **inserts the current server's ID** for you.

### Arguments (`target`)

Comma- or semicolon-separated, in any order and any mix. Each token is classified by **what it is**, not by its position:

| Token | Meaning |
| --- | --- |
| all-digit number | A **server (guild) ID** or **channel ID** where this account is allowed to catch. |
| plain text (`ponyta`, `galarian ponyta`) | An **exact** Pokémon name to catch. Spaces inside a name are fine. `ponyta` does **not** match `galarian ponyta`. |
| `something.json` | A **datafile** of names. Looked up in `data/targetcatch/`, then `data/`, then the script folder. A file can be an array (`["pikachu", "ponyta"]`) or `{ "pokemon": ["pikachu"] }`. |

**Examples**

```
.grinder add autocatch 1
.grinder add autocatch 1 123456789012345678
.grinder add autocatch 2 ponyta
.grinder add autocatch 3 galarian ponyta, pikachu
.grinder add autocatch 1 111111111111111111, 222222222222222222, rares.json
.grinder add autocatch 2 rares.json, ponyta
```

In each line the first number after `autocatch` is the **account number**; everything after it is the target.

### How a spawn is handled

1. The detector message (text **and** embeds) is cleaned and the Pokémon name is extracted. The **variant is kept for matching** (`galarian ponyta`), but the **base name is what is sent** to Pokétwo (`ponyta`). The base name is found with `data/pokevars.json`; known variant prefixes are `alolan`, `galarian`, `hisuian`, `paldean`, `christmas`.
2. Only **one detection per channel** is handled in a **10 second window**; further detector messages in that channel are ignored until the window ends.
3. Every active, non-paused `autocatch` config is checked:
   - **Visibility**: the account must be in the server where the message was posted.
   - **Location** (see below).
   - **Excludes**: skipped if the Pokémon is excluded for the config's server.
   - **Pokémon filter**: if the target contains a name or datafile, the detected name must match it **exactly**. A filter that is set but empty or missing matches nothing - it never falls back to "catch everything".
4. A catcher is chosen by **priority** (highest first):

   | Priority | When |
   | --- | --- |
   | **3** | The Pokémon was typed directly in the target (`ponyta`). |
   | **2** | The Pokémon came from a `.json` datafile. |
   | **1** | No Pokémon filter - the account catches everything. |

   Inside priority 3 and 2, matching accounts take turns **round-robin**. Inside priority 1, active accounts are grouped into **pairs** and the pair that owns the current slice of the day (Hong Kong time) is used; the two accounts of the pair alternate. With an odd number of accounts, the last one is paired with the first.
5. The chosen account waits **1.0 - 1.5 seconds**, then sends `@Poketwo c <name>`. About **10 %** of the time it first sends a typo and **edits** the message to the correct name 300 ms later.
6. If Pokétwo confirms the catch within 15 seconds, a 🎉 message goes to the **Autocatch** log channel.

### Location rules

| Config's target | Behaviour |
| --- | --- |
| **No IDs** (old configs) | The account only catches in the server that owns the config. |
| **IDs that include this server or channel** | Normal catching, **no ping needed**. |
| **IDs given, none match this location** | Not used - a config never catches anywhere it does not point to. |
| Spawn is in a **different** server than the config's own server | Only if the detector message **pings this account**. Pinged + no filter = all pinged Pokémon; pinged + filter = only pinged **and** targeted Pokémon. |

### Excludes

Per-server list of Pokémon that must never be caught. Manage in `.grinder` → **🚫 Excludes** (type names separated by commas).

```
pikachu, gimmighoul, raikou --xnon
```

| Form | Meaning |
| --- | --- |
| `pikachu` | Skips any detected name that **contains** `pikachu` (`pikachu`, `alolan pikachu`, ...). |
| `pikachu --xnon` | Skips **only variants** (names that contain `pikachu` but are not exactly `pikachu`). Plain `pikachu` is still caught. |

### Rotation info

`.grinder` → **🎯 AutoCatch** shows the active pairs and which account has the current turn.

---

## `spam`

Sends random lines from `data/messages.txt` into a channel **once per second**.

> Use this only in channels you own or in a private test server. Automated message flooding is against Discord's rules and most servers' rules.

### Setup

1. Put your lines in `data/messages.txt`, **one message per line** (blank lines are ignored). **Replace the file's contents with whatever you want** - it is re-read on every send, so you can edit it while the engine runs.
2. Add the config with the **channel ID**:

```
.grinder add spam <account number> <channel ID>
```

### Arguments

| Argument | Required | Meaning |
| --- | --- | --- |
| Channel ID | ✅ | Digits only. The controller refuses `spam` without one. |

**Examples**

```
.grinder add spam 1 123456789012345678
.grinder add spam 2 123456789012345678
.grinder add spam 3 123456789012345678
```

### Behaviour

- All spam configs on the **same channel** form a group, in config order. Each tick **one** account sends and the next account takes the following tick: `x1`, then `x2`, then `x3`, back to `x1`. Accounts that are not logged in are skipped.
- The gap between two messages in a channel is exactly **1 second** (absolute deadlines, no drift; after a stall the engine re-anchors instead of sending a burst).
- Each message is chosen at random from `messages.txt`.
- **Pausing** a spam config logs that account out and back in, to instantly clear any queued sends.
- A captcha alert for the account pauses its spam configs ([details](#safety-captcha-and-logging)).

---

## `dotcatch`

A manual helper: you ask for a hint with a single `.` and the account catches the answer.

### Setup

1. Register a detector bot that answers hints with `Possible Pokémon: <name>` (`.grinder` → **🤖 Detector Bots**).
2. Create the config **in the server where you will use it**:

```
.grinder add dotcatch <account number> <channel ID>
```

The controller requires a channel ID for this mode, but the engine does not use it: the config is active for the whole server that owns it.

### How to use

1. From the account, send a message that is **exactly** `.` in a channel of that server.
2. The account sends `@Poketwo h` (hint request).
3. When a detector bot replies in that channel with `Possible Pokémon: <name>`, **that same account** sends `@Poketwo c <name>` (with the same 10 % typo-then-edit behaviour as autocatch).

Notes: only the account that sent the `.` answers; only one pending request per channel is tracked; successful `dotcatch` catches are **not** written to the log channel.

---

## `commaedit`

A typing shortcut for writing Pokétwo commands quickly.

### Setup

```
.grinder add commaedit <account number> <channel ID>
```

As with `dotcatch`, the controller requires a channel ID but the engine does not use it; the config applies to the whole server that owns it.

### How to use

When the account sends a message containing `,` **in that server**, the engine **edits the message**, replacing every `,` with a Pokétwo mention (`<@716390085896962058>`).

Example: typing `, c ponyta` becomes `@Poketwo c ponyta`.

> Because every comma is replaced, normal sentences with commas will be changed too. Pause the config when you want to chat normally.

---

## Shared settings

Set from `.grinder` (owner only). They are stored per server.

| Setting | Panel page | Used by | Details |
| --- | --- | --- | --- |
| **Accounts** | ⚙️ Accounts | all | Add / edit (replace token) / delete accounts. Tokens are never shown. |
| **Detector bots** | 🤖 Detector Bots | `autocatch`, `dotcatch` | User IDs of bots whose messages are read as predictions or hints. The engine accepts messages from the detector bots of **all** servers. |
| **Excludes** | 🚫 Excludes | `autocatch` | See [Excludes](#excludes). |
| **Logs** | 📜 Logs | `autocatch`, captcha handling | See below. |

### Log channels

| Log | Receives |
| --- | --- |
| 🔔 **Alerts** | Captcha alerts with the message link and the verification link. |
| 🎯 **Autocatch** | `🎉 Success!` messages when an autocatch attempt is confirmed by Pokétwo. |

Logs are sent by one of the logged-in accounts (the one that caught, or the first running account).

---

## Controlling configs

| Command | Description |
| --- | --- |
| `.grinder` (alias `.grind`) | Opens the panel for the current server: configs, autocatch pairs, excludes, detector bots, logs, accounts. |
| `.grinder add <mode> <account> [args]` (alias `a`) | Adds a config. Slash command offers the four modes as choices. |
| `.grinder remove <number>` (alias `r`) | Removes the config with that number from the server's list. |
| `.grinder syncguilds <from server ID> <to server ID>` (aliases `sync`, `sg`) | Copies the **non-spam** configs, the excludes and the logs from one server to another. |
| `.pause [numbers] [duration]` (alias `.p`) | Pauses the listed configs, or **all** if you give none. A duration (`30s`, `2h`, `1d`) makes the pause temporary and the config **resumes by itself**. |
| `.resume [numbers] [duration]` (alias `.r`) | Resumes the listed configs, or **all**. With a duration the config stays active that long, then **pauses again**. |

**Examples**

```
.pause                 pause every config in this server
.pause 2               pause config #2 indefinitely
.pause 1 3 40m         pause configs #1 and #3 for 40 minutes
.resume 2              resume config #2
.resume 2 10s          resume config #2 for 10 seconds, then pause it again
.resume                resume everything
```

Durations need a unit (`s`, `m`, `h` or `d`); a plain number is read as a config number. Config numbers can be separated by spaces or commas. Pauses and resumes that involve several configs ask for confirmation first.

---

## Safety, captcha and logging

- **Captcha handling**: if Pokétwo answers "whoa there" to an account - because the message mentions it, or because it attempted a catch in that channel within the last **30 seconds** - then **all `autocatch` and `spam` configs of that account are paused indefinitely**. A 🚨 alert with the message link and the **verify link** is sent to the guild's **Alerts** log channel. The engine never solves captchas: verify the account yourself, then run `.resume` (the alert itself tells you this; `.pause` stops configs again).
- **Auto-resume / auto-pause**: a 1-second timer checks `pauseUntil` and `resumeUntil`.
- **Success logs**: when Pokétwo says `Congratulations <@account>` and that account made an autocatch attempt in the last 15 seconds, a 🎉 message is logged.
- **Name lookups**: the controller can ask the engine to resolve server/channel names (`grinder/name_requests`). The engine asks a logged-in account (the config's own account first) and writes the answer to `grinder/id_names`.

---

## Data files

All inside `data/` (created automatically if missing):

| File | Purpose |
| --- | --- |
| `messages.txt` | Spam lines, one per line. Replace it with whatever you want; created with two placeholder lines if missing. |
| `pokevars.json` | JSON array of base Pokémon names (re-read on every Firebase update). Used to turn variant names into the name that is sent and to scan detector messages. |
| `autocatch.json` | Generated: `{ "pairs": [...], "active_autocatchers": [...] }`. Do not edit. |
| `targetcatch/*.json` | Optional target lists referenced by `autocatch` (`rares.json`, ...). |

---

## How the engine runs

- **Supervisor**: `index.js` forks itself as a child process (`GRINDER_CHILD=1`). If the child crashes it restarts with back-off (3 s, 6 s, ... capped at 30 s; the counter resets after 60 s of stable running). Exit code `0` stops for good; exit code `42` means "restart for update" and restarts after 0.5 s.
- **Firebase sync**: any change under `grinder` is picked up instantly. Added accounts are logged in, removed accounts are logged out.
- **Remote updates**: `.pull grinder` makes `pull.js` run `git fetch` + `git pull --ff-only` (or `reset --hard` with `hard`), reinstall dependencies if `package.json` changed, and restart with exit code `42`. The folder must be a git repository (`GRINDER_REPO_DIR`, `GRINDER_REPO_URL`, `GRINDER_REPO_BRANCH` can be set).

---

## Troubleshooting

| Mode | Symptom | Check |
| --- | --- | --- |
| all | Config does nothing | Is it paused (`.grinder` shows ⏸️ or 🟢)? Is the account logged in (`[+] Logged in as Acc #N` in the console)? |
| `autocatch` | Never catches | Detector bot registered for that server? Message looks like `Name: 97%`? Account is a member of the server? Pokémon excluded? Target filter too narrow (exact names only)? |
| `autocatch` | Account in another server does not catch | In a server that is not the config's own, the account must be **pinged** in the detector message. |
| `autocatch` | Wrong account catches | Check priorities: a named Pokémon (3) beats a datafile (2) beats no filter (1). |
| `spam` | Nothing is sent | `target` must be a numeric channel ID; `messages.txt` must have non-empty lines; the account must be able to see and write in that channel. |
| `dotcatch` | Nothing happens after `.` | Config must be created in **that server**; the message must be exactly `.`; a detector bot must reply with `Possible Pokémon: <name>`. |
| `commaedit` | Commas are not replaced | Config must exist in that server and not be paused; only messages sent by the configured account are edited. |
| captcha | Everything stopped for one account | Complete the verification, then `.resume`. |