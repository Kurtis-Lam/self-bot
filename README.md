# Discord Self-Bot Grinder Engine

> ⚠️ **DISCLAIMER: USE AT YOUR OWN RISK**
> Using self-bots or automated scripts on user accounts violates [Discord's Terms of Service](https://www.google.com/search?q=https://discord.com/terms&utm_source=gemini). Using this software can result in account warnings, temporary suspensions, or permanent bans. The developers assume no responsibility for any actions taken against your accounts.

An automated engine built with `discord.js-selfbot-v13` and Firebase Realtime Database. It manages multiple Discord user accounts simultaneously to execute automated tasks including auto-catching, channel spamming, scheduled messaging, and utility helper modes.

---

## Architecture Overview

This project operates on a controller-engine model:

```
┌────────────────────────────────────────┐
│   Discord Utilities Control Bot        │
│   https://github.com/Kurtis-Lam/utilities│
└───────────────────┬────────────────────┘
                    │ (Pushes commands & configs)
                    ▼
┌────────────────────────────────────────┐
│     Firebase Realtime Database         │
└───────────────────┬────────────────────┘
                    │ (Real-time sync)
                    ▼
┌────────────────────────────────────────┐
│     Grinder Engine (This Repo)         │
│   https://github.com/Kurtis-Lam/self-bot │
└────────────────────────────────────────┘

```

1. **Controller Bot**: Go to [Kurtis-Lam/utilities](https://github.com/Kurtis-Lam/utilities?utm_source=gemini) to clone and host the control bot. This bot receives user commands in Discord and updates the shared Firebase database.
2. **Database**: Acts as the central command broker storing account tokens, target lists, engine modes, pause states, and logs.
3. **Self-Bot Engine**: This script (`self-bot`) continuously syncs with Firebase, spawns client sessions for each account, listens to target channels, and executes tasks.

---

## Key Features

* **Multi-Account Management**: Runs multiple tokens concurrently with dynamic connection lifecycle management (login, logout, rotation).
* **Smart Auto-Catching Engine**:
* Integrates with detection bots to parse spawned Pokémon.
* Supports target JSON lists, server/channel targeting, and custom exclusion lists.
* Atomic turn-based rotation to prevent multiple accounts from catching the exact same spawn.
* Human-like random typing delays and simulated typos.


* **Captcha Detection & Alerting**: Automatically detects Pokétwo captcha checks ("Whoa there"), immediately pauses the flagged account in Firebase, and dispatches an alert link to a designated logging channel.
* **Spam Engine**: Rotates accounts across designated target channels to send randomized messages from `data/messages.txt`.
* **Periodic Messaging**: Automated messaging based on configurable minimum/maximum delay ranges (`t1` to `t2`).
* **Utility Modes**:
* **CommaEdit**: Automatically edits `,` in your messages into `<@716390085896962058>` mentions.
* **DotCatch**: Send `.` in a channel to request hints and automatically catch the matched Pokémon.



---

## File Structure

```text
├── index.js              # Main application entry point
├── firebase_key.json     # Firebase service account credential file
├── package.json          # Project dependencies
└── data/
    ├── messages.txt      # Line-separated list of spam messages
    ├── pokevars.json     # Target name variations / word lists
    ├── autocatch.json    # Cached active pairs (generated automatically)
    └── targetcatch/      # Optional directory for custom target JSON files

```

---

## Setup & Installation

### Prerequisites

* [Node.js](https://www.google.com/search?q=https://nodejs.org/&utm_source=gemini) (v16+ recommended)
* A [Firebase Project](https://www.google.com/search?q=https://firebase.google.com/&utm_source=gemini) with a Realtime Database set up.
* A cloned instance of [Kurtis-Lam/utilities](https://github.com/Kurtis-Lam/utilities?utm_source=gemini) to manage and send orders to Firebase.

### Steps

1. **Clone this repository**:
```bash
git clone https://github.com/Kurtis-Lam/self-bot.git
cd self-bot

```


2. **Install dependencies**:
```bash
npm install

```


3. **Configure Firebase Service Account**:
* Download your Firebase Admin SDK service account key JSON file from your Firebase Console.
* Save it in the project root directory as `firebase_key.json`.


4. **Update Firebase Database URL**:
* Open `index.js`.
* Replace `<put-here>` in the `initializeApp` section with your Firebase Realtime Database name:
```javascript
initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://<your-db-name>-default-rtdb.firebaseio.com/"
});

```




5. **Populate Data Files**:
* Add text lines to `data/messages.txt` for the spam module.
* Add target variables to `data/pokevars.json` as needed.


6. **Start the Engine**:
```bash
node index.js

```


---

## Usage

Once `index.js` is running, it will automatically connect to Firebase and await configuration directives. Commands to add accounts, start auto-catching, trigger spammers, or adjust targets should be issued using your controller bot deployed from the [utilities repository](https://github.com/Kurtis-Lam/utilities).


---

## 📜 License

This application's source code is shared under the **PolyForm Noncommercial License 1.0.0**. 

* **Personal & Educational Use:** Free to use, modify, and explore. You must give credit to the original author.
* **Commercial Use:** If you intend to use this code to earn revenue, build a commercial product, or use it within a business, you **must purchase a commercial license**.

For commercial licensing terms and pricing, please contact me at: `kurtislam100@gmail.com`

---

## 🙌 Acknowledgements

Built with ❤️ by Kurtis.