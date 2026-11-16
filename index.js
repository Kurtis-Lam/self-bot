if (process.env.GRINDER_CHILD !== "1") {
  const { fork } = require("child_process");
  const RESTART_DELAY_MS = 3000;      
  const MAX_DELAY_MS = 30000;         
  const STABLE_AFTER_MS = 60000;      

  let child = null;
  let shuttingDown = false;
  let crashStreak = 0;

  const startChild = () => {
    const startedAt = Date.now();
    child = fork(__filename, process.argv.slice(2), {
      env: { ...process.env, GRINDER_CHILD: "1" }
    });

    child.on("exit", (code, signal) => {
      child = null;
      if (shuttingDown) process.exit(0);
      if (code === 0) {
        console.log("[supervisor] Bot exited cleanly. Not restarting.");
        process.exit(0);
      }
      if (code === 42) {
        console.log("[supervisor] Restart requested (update). Restarting...");
        crashStreak = 0;
        setTimeout(startChild, 500);
        return;
      }

      crashStreak = (Date.now() - startedAt >= STABLE_AFTER_MS) ? 1 : crashStreak + 1;
      const wait = Math.min(RESTART_DELAY_MS * crashStreak, MAX_DELAY_MS);
      console.error(`[supervisor] Bot crashed (code=${code}, signal=${signal}). Restarting in ${wait / 1000}s...`);
      setTimeout(startChild, wait);
    });
  };

  const stop = (sig) => {
    shuttingDown = true;
    if (child) child.kill(sig);
    else process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  startChild();
  return; 
}

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
  process.exit(1);
});

console.log("=== GRINDER ENGINE SCRIPT LAUNCHING (ADVANCED SPOOFING & BEHAVIOR) ===");

const { Client } = require("discord.js-selfbot-v13");
const fs = require("fs-extra");
const path = require("path");
const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { setupUpdater } = require("./pull");

// --- FIREBASE SETUP ---
const FIREBASE_KEY_FILE = path.join(__dirname, "firebase_key.json");
let serviceAccount;
try {
  serviceAccount = JSON.parse(fs.readFileSync(FIREBASE_KEY_FILE, "utf-8"));
} catch (err) {
  console.error(`[FATAL] Could not read firebase_key.json (${err.message}).`);
  process.exit(1);
}
const FIREBASE_DATABASE_URL = String(serviceAccount.database_url || serviceAccount.databaseURL || "").trim();
if (!FIREBASE_DATABASE_URL) {
  console.error('[FATAL] firebase_key.json has no "database_url" field.');
  process.exit(1);
}

initializeApp({
  credential: cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db = getDatabase();
const grinderRef = db.ref("grinder");

// --- FILE SYSTEM CONFIGURATION ---
const DATA_DIR = path.join(__dirname, "data");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.txt");
const AUTOCATCH_FILE = path.join(DATA_DIR, "autocatch.json");
const POKE_VARS_FILE = path.join(DATA_DIR, "pokevars.json");

fs.ensureDirSync(DATA_DIR);
if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, "spam message here\nanother message here", "utf-8");
if (!fs.existsSync(POKE_VARS_FILE)) fs.writeJsonSync(POKE_VARS_FILE, [], { spaces: 2 });

// --- POKE-VARS CACHE LOADING ---
let pokeVarsSet = new Set();
function loadPokeVars() {
  try {
    if (fs.existsSync(POKE_VARS_FILE)) {
      const data = fs.readJsonSync(POKE_VARS_FILE);
      pokeVarsSet.clear();
      if (Array.isArray(data)) {
        data.forEach(item => {
          if (typeof item === 'string') {
            const normalized = cleanPokemonName(item);
            if (normalized) pokeVarsSet.add(normalized);
          }
        });
      }
    }
  } catch (err) {
    console.error("[-] Failed to load pokevars.json:", err.message);
  }
}
loadPokeVars();

// --- GLOBAL DEFINITIONS ---
const POKETWO_ID = "716390085896962058";

// --- IN-MEMORY DATA CACHE ---
let currentAccounts = [];
let currentDetectorBots = new Set();
let currentConfigData = {
  configs: {},   
  excludes: {},  
  logs: {}       
};

const runningClients = new Map(); 
const startingTokens = new Set(); 
const dotcatchWaiters = new Map(); 

let currentAutocatchPairs = [];
let cachedActiveAutocatchers = [];
const pairTurnStates = new Map(); 
const detectionAssignments = new Map(); 

let spamTurns = {}; 
const channelDetectLock = new Map(); 
const DETECT_LOCK_MS = 7500;

let recentCatchHistory = new Map(); 
let channelLastActionAcc = new Map(); 
const recentCatchAttempts = new Map(); 

// --- ORGANIC SESSION & AFK TRACKER ---
const accountSessionState = new Map(); // token -> { isAfk: boolean, nextStateChange: number }

function updateAccountSession(token, client) {
  const now = Date.now();
  let state = accountSessionState.get(token);

  if (!state) {
    // Active window: 90 to 180 minutes
    const activeDuration = (90 + Math.floor(Math.random() * 90)) * 60 * 1000;
    state = { isAfk: false, nextStateChange: now + activeDuration };
    accountSessionState.set(token, state);
    if (client?.user) client.user.setStatus("online").catch(() => {});
    return state;
  }

  if (now >= state.nextStateChange) {
    if (!state.isAfk) {
      // Transition to AFK break: 15 to 45 minutes
      const breakDuration = (15 + Math.floor(Math.random() * 30)) * 60 * 1000;
      state.isAfk = true;
      state.nextStateChange = now + breakDuration;
      console.log(`[behavior] Account entering organic AFK break for ${Math.round(breakDuration / 60000)}m`);
      if (client?.user) client.user.setStatus("idle").catch(() => {});
    } else {
      // Return to active grinding: 90 to 180 minutes
      const activeDuration = (90 + Math.floor(Math.random() * 90)) * 60 * 1000;
      state.isAfk = false;
      state.nextStateChange = now + activeDuration;
      console.log(`[behavior] Account resuming active session for ${Math.round(activeDuration / 60000)}m`);
      if (client?.user) client.user.setStatus("online").catch(() => {});
    }
  }

  return state;
}

// --- UTILITIES ---
function parseDuration(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)([smhd])?$/i);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = (match[2] || "m").toLowerCase(); 
  switch (unit) {
    case "s": return val * 1000;
    case "m": return val * 60 * 1000;
    case "h": return val * 3600 * 1000;
    case "d": return val * 86400 * 1000;
    default: return val * 60 * 1000;
  }
}

function formatDuration(ms) {
  if (!ms) return "indefinitely";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h`;
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// --- GAUSSIAN / BELL-CURVE HUMAN REACTION DELAY ---
function gaussianRandom(mean, stdDev) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z * stdDev + mean;
}

async function humanReactionDelay(meanMs = 1800, stdDevMs = 450, minFloorMs = 950) {
  let wait = Math.round(gaussianRandom(meanMs, stdDevMs));
  
  // 6% chance of a "distracted" pause (e.g. tabbed out or reading another channel)
  if (Math.random() < 0.06) {
    wait += Math.floor(Math.random() * 4500) + 2500;
  }

  wait = Math.max(minFloorMs, wait);
  await delay(wait);
}

// --- PROPORTIONAL HUMAN TYPING SIMULATION ---
async function simulateHumanTyping(channel, textToType) {
  if (!channel || !channel.sendTyping) return;
  try {
    await channel.sendTyping().catch(() => {});
    // Average human typing speed: ~160ms to 260ms per character + base cognitive start
    const perCharMs = 160 + Math.floor(Math.random() * 100);
    const typingTime = Math.min(5500, Math.max(650, textToType.length * perCharMs));
    await delay(typingTime);
  } catch (_) {}
}

// --- POKEMON CLEANING & MATCHING ---
function cleanPokemonName(name) {
  return name
    .replace(/[\p{Emoji}\p{Extended_Pictographic}]/gu, "")
    .toLowerCase()
    .replace(/é/g, "e")
    .replace(/\s+/g, " ")
    .trim();
}

const KNOWN_VARIANT_PREFIXES = new Set(["alolan", "galarian", "hisuian", "paldean", "christmas"]);

function getBestCatchName(pokemonName) {
  const cleaned = cleanPokemonName(pokemonName);
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length <= 1) return cleaned;

  for (let i = 1; i < words.length; i++) {
    const suffix = words.slice(i).join(" ");
    if (pokeVarsSet.has(suffix)) return suffix;
  }

  let i = 0;
  while (i < words.length - 1 && KNOWN_VARIANT_PREFIXES.has(words[i])) i++;
  if (i > 0) return words.slice(i).join(" ");

  if (pokeVarsSet.has(cleaned)) return cleaned;

  const matchingWords = words.filter(w => pokeVarsSet.has(w));
  if (matchingWords.length > 0) return matchingWords[matchingWords.length - 1];
  return cleaned;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractDetectedName(cleanedContent) {
  const scanName = findFirstPokemonNameInMessage(cleanedContent);
  let rawName = null;
  const m = cleanedContent.match(/^\s*([^:]+?):\s*\d+(?:\.\d+)?%/m);
  if (m) rawName = cleanPokemonName(m[1]);

  if (rawName) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(scanName || "")}([^a-z0-9]|$)`);
    if (!scanName || re.test(rawName)) return rawName;
  }
  return scanName;
}

function loadTargetFile(fileName) {
  let jsonPath = path.join(DATA_DIR, "targetcatch", fileName);
  if (!fs.existsSync(jsonPath)) jsonPath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(jsonPath)) jsonPath = path.join(__dirname, fileName);

  const names = [];
  try {
    if (fs.existsSync(jsonPath)) {
      const jsonData = fs.readJsonSync(jsonPath);
      const list = Array.isArray(jsonData) ? jsonData : (jsonData.pokemon || []);
      list.forEach(p => {
        if (typeof p === "string" && p.trim()) names.push(cleanPokemonName(p));
      });
    }
  } catch (e) {
    console.error(`[-] Failed to read datafile ${fileName}: ${e.message}`);
  }
  return names;
}

function parseAutocatchTarget(target) {
  const ids = [];
  const pokemons = [];
  let hasPokemonFilter = false;

  const parts = String(target || "").split(/[,;]/).map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    const nameTokens = [];
    for (const tok of part.split(/\s+/).filter(Boolean)) {
      if (/^\d+$/.test(tok)) {
        ids.push(tok);
      } else if (tok.toLowerCase().endsWith(".json")) {
        hasPokemonFilter = true;
        for (const n of loadTargetFile(tok)) pokemons.push({ name: n, fromJson: true });
      } else {
        nameTokens.push(tok);
      }
    }
    if (nameTokens.length > 0) {
      hasPokemonFilter = true;
      pokemons.push({ name: cleanPokemonName(nameTokens.join(" ")), fromJson: false });
    }
  }

  return { ids, pokemons, hasLocations: ids.length > 0, hasPokemonFilter };
}

function findFirstPokemonNameInMessage(cleanedContent) {
  if (!cleanedContent || pokeVarsSet.size === 0) return null;
  const lowerContent = cleanedContent.toLowerCase().replace(/é/g, "e");
  let firstMatch = null;

  for (const pokeVar of pokeVarsSet) {
    if (!pokeVar) continue;
    const target = pokeVar.toLowerCase().trim();
    if (!target) continue;

    let startPos = 0;
    while (startPos < lowerContent.length) {
      const index = lowerContent.indexOf(target, startPos);
      if (index === -1) break;

      const charBefore = index > 0 ? lowerContent[index - 1] : ' ';
      const charAfter = (index + target.length < lowerContent.length) ? lowerContent[index + target.length] : ' ';
      const isWordChar = (ch) => /[a-z0-9]/i.test(ch);

      if (!isWordChar(charBefore) && !isWordChar(charAfter)) {
        if (!firstMatch || index < firstMatch.index || (index === firstMatch.index && target.length > firstMatch.name.length)) {
          firstMatch = { name: target, index: index };
        }
        break;
      }
      startPos = index + 1;
    }
  }
  return firstMatch ? firstMatch.name : null;
}

function isAccountMentioned(message, fullContent, targetAccId) {
  if (!targetAccId) return false;
  if (message.mentions && message.mentions.users && message.mentions.users.has(targetAccId)) return true;
  if (fullContent) {
    const re = new RegExp(`(^|[^0-9])${targetAccId}([^0-9]|$)`);
    if (re.test(fullContent)) return true;
  }
  return false;
}

function matchPokemon(spawnedName, targetName, isXnon = false) {
  const spawnLower = spawnedName.toLowerCase().trim();
  const targetLower = targetName.toLowerCase().trim();
  if (isXnon) {
    return spawnLower.includes(targetLower) && spawnLower !== targetLower;
  } else {
    return spawnLower.includes(targetLower);
  }
}

function makeTypo(name) {
  if (name.length < 2) return name;
  const arr = name.split("");
  const idx = Math.floor(Math.random() * (arr.length - 1));
  const temp = arr[idx];
  arr[idx] = arr[idx + 1];
  arr[idx + 1] = temp;
  return arr.join("");
}

// --- ENHANCED CATCH COMMAND WITH PROPORTIONAL TYPING & TYPO RECOVERY ---
async function sendCatchCommand(channel, finalCatchName, acc) {
  recentCatchAttempts.set(`${channel.id}_${acc.index}`, {
    accIndex: acc.index,
    token: acc.token,
    timestamp: Date.now()
  });

  try {
    const commandText = `@Pokétwo c ${finalCatchName}`;
    await simulateHumanTyping(channel, commandText);

    // 10% chance of making a human transposition typo and editing it
    if (Math.random() < 0.10 && finalCatchName.length > 3) {
      const typoedName = makeTypo(finalCatchName);
      const sentMsg = await channel.send(`<@${POKETWO_ID}> c ${typoedName}`).catch(() => null);
      if (sentMsg) {
        await humanReactionDelay(1100, 300, 700);
        await sentMsg.edit(`<@${POKETWO_ID}> c ${finalCatchName}`).catch(() => {});
      }
    } else {
      await channel.send(`<@${POKETWO_ID}> c ${finalCatchName}`).catch(() => {});
    }
  } catch (err) {
    console.error(`[-] Error sending catch command for Acc #${acc.index}:`, err.message);
  }
}

// --- FIREBASE & CLIENT MANAGEMENT ---
async function updateRunningAccounts(rawTokens) {
  const activeTokens = new Set(rawTokens);

  for (const [token, client] of runningClients) {
    if (!activeTokens.has(token)) {
      client.destroy();
      runningClients.delete(token);
      accountSessionState.delete(token);
    }
  }

  currentAccounts = rawTokens.map((token, idx) => {
    const existing = currentAccounts.find(a => a.token === token);
    return {
      index: idx + 1,
      token: token,
      id: existing ? existing.id : null
    };
  });

  for (const acc of currentAccounts) {
    if (!runningClients.has(acc.token) && !startingTokens.has(acc.token)) {
      // Stagger logins across multiple accounts so they don't all hit the gateway simultaneously
      await delay(1500 + Math.floor(Math.random() * 2500));
      await startAccountClient(acc);
    }
  }
}

function syncAutocatchPairs() {
  const activeAccTokens = new Set();
  for (const guildId in currentConfigData.configs) {
    currentConfigData.configs[guildId].forEach(c => {
      const isPaused = c.paused === true || String(c.paused).toLowerCase() === "true";
      if (c.mode === "autocatch" && !isPaused) {
        const accToken = c.token || (currentAccounts[c.accIndex - 1] ? currentAccounts[c.accIndex - 1].token : null);
        if (accToken) activeAccTokens.add(accToken);
      }
    });
  }

  const currentActiveTokens = Array.from(activeAccTokens).sort();
  if (JSON.stringify(currentActiveTokens) === JSON.stringify(cachedActiveAutocatchers)) return;

  cachedActiveAutocatchers = currentActiveTokens;
  const pairs = [];
  if (currentActiveTokens.length === 1) {
    pairs.push([currentActiveTokens[0], currentActiveTokens[0]]);
  } else if (currentActiveTokens.length > 1) {
    for (let i = 0; i < currentActiveTokens.length; i += 2) {
      if (i + 1 < currentActiveTokens.length) {
        pairs.push([currentActiveTokens[i], currentActiveTokens[i + 1]]);
      } else {
        pairs.push([currentActiveTokens[i], currentActiveTokens[0]]);
      }
    }
  }

  currentAutocatchPairs = pairs;
  const indexPairs = pairs.map(pair => pair.map(tok => {
    const accIdx = currentAccounts.findIndex(a => a.token === tok) + 1;
    return accIdx > 0 ? accIdx : tok;
  }));

  grinderRef.child("autocatch/pairs").set(indexPairs).catch(() => {});
  fs.outputJsonSync(AUTOCATCH_FILE, { pairs, active_autocatchers: currentActiveTokens });
}

function setupFirebaseListener() {
  grinderRef.on("value", async (snapshot) => {
    const data = snapshot.val() || {};
    const accountsList = data.accounts || [];
    const newConfigs = data.configs || {};
    currentConfigData.excludes = data.excludes || {};
    currentConfigData.logs = data.logs || {};
    
    const dbots = data.detector_bots || {};
    currentDetectorBots.clear();
    for (const guildId in dbots) {
      if (Array.isArray(dbots[guildId])) dbots[guildId].forEach(botId => currentDetectorBots.add(botId));
    }
    loadPokeVars();

    let needsMigration = false;
    const accountsToRestart = new Set();
    
    for (const guildId in newConfigs) {
      const nCfgs = newConfigs[guildId] || [];
      const oCfgs = currentConfigData.configs[guildId] || [];
      nCfgs.forEach((newC, i) => {
        if (!newC.token && newC.accIndex) {
          const t = accountsList[newC.accIndex - 1];
          if (t) { newC.token = t; needsMigration = true; }
        }
        const oldC = oCfgs[i];
        const isNewPaused = newC.paused === true || String(newC.paused).toLowerCase() === "true";
        const isOldPaused = oldC ? (oldC.paused === true || String(oldC.paused).toLowerCase() === "true") : false;
        
        if (newC.mode === "spam" && isNewPaused && !isOldPaused) {
          const accToken = newC.token || accountsList[newC.accIndex - 1];
          if (accToken) accountsToRestart.add(accToken);
        }
      });
    }

    if (needsMigration) grinderRef.child("configs").set(newConfigs).catch(() => {});
    currentConfigData.configs = newConfigs;

    await updateRunningAccounts(accountsList);
    syncAutocatchPairs();

    for (const token of accountsToRestart) {
      if (runningClients.has(token)) {
        const client = runningClients.get(token);
        client.destroy();
        runningClients.delete(token);
        const acc = currentAccounts.find(a => a.token === token);
        if (acc) {
          setTimeout(() => {
            if (!runningClients.has(acc.token) && !startingTokens.has(acc.token)) startAccountClient(acc);
          }, 1500);
        }
      }
    }
  });
}

const nameRequests = new Map();
let processingNameRequests = false;

async function lookupIdName(client, id) {
  const guild = client.guilds.cache.get(id);
  if (guild) return { type: "guild", name: guild.name };
  let channel = client.channels.cache.get(id) || await client.channels.fetch(id).catch(() => null);
  if (channel && channel.name) {
    return { type: "channel", name: channel.name, guildName: channel.guild ? channel.guild.name : null };
  }
  return null;
}

async function processNameRequests() {
  if (processingNameRequests || nameRequests.size === 0) return;
  const readyClients = Array.from(runningClients.entries()).filter(([, c]) => c.isReady && c.isReady());
  if (readyClients.length === 0) return;

  processingNameRequests = true;
  try {
    for (const [id, req] of Array.from(nameRequests.entries())) {
      const preferredToken = currentAccounts[(req.accIndex || 0) - 1]?.token;
      const ordered = [
        ...readyClients.filter(([tok]) => tok === preferredToken),
        ...readyClients.filter(([tok]) => tok !== preferredToken)
      ];

      let result = null;
      for (const [, client] of ordered) {
        try { result = await lookupIdName(client, id); } catch (_) { result = null; }
        if (result) break;
      }

      const payload = { checkedAt: Date.now() };
      if (result) {
        payload.type = result.type;
        payload.name = result.name;
        if (result.guildName) payload.guildName = result.guildName;
      }

      await grinderRef.child("id_names").child(id).set(payload).catch(() => {});
      await grinderRef.child("name_requests").child(id).remove().catch(() => {});
      nameRequests.delete(id);
    }
  } finally {
    processingNameRequests = false;
  }
}

function setupNameRequestListener() {
  grinderRef.child("name_requests").on("value", (snapshot) => {
    const data = snapshot.val() || {};
    for (const id of Object.keys(data)) {
      if (!nameRequests.has(id)) nameRequests.set(id, data[id] || {});
    }
    processNameRequests().catch(() => {});
  });
}

function pauseAccountInFirebase(accIndex = null, durationMs = null) {
  let modified = false;
  const pauseUntil = durationMs ? Date.now() + durationMs : null;

  for (const guildId in currentConfigData.configs) {
    currentConfigData.configs[guildId].forEach(c => {
      const cfgAccIdx = c.token ? (currentAccounts.findIndex(a => a.token === c.token) + 1) : c.accIndex;
      if ((accIndex === null || String(cfgAccIdx) === String(accIndex)) && ["autocatch", "spam"].includes(c.mode)) {
        c.paused = true;
        c.pauseUntil = pauseUntil;
        c.resumeUntil = null;
        modified = true;
      }
    });
  }

  if (modified) {
    grinderRef.child("configs").set(currentConfigData.configs).catch(() => {});
    syncAutocatchPairs();
  }
}

setInterval(() => {
  let modified = false;
  const now = Date.now();
  for (const guildId in currentConfigData.configs) {
    currentConfigData.configs[guildId].forEach(c => {
      const isPaused = c.paused === true || String(c.paused).toLowerCase() === "true";
      if (isPaused && c.pauseUntil && now >= c.pauseUntil) {
        c.paused = false;
        c.pauseUntil = null;
        c.resumeUntil = null;
        modified = true;
      } else if (!isPaused && c.resumeUntil && now >= c.resumeUntil) {
        c.paused = true;
        c.pauseUntil = null;
        c.resumeUntil = null;
        modified = true;
      }
    });
  }
  if (modified) {
    grinderRef.child("configs").set(currentConfigData.configs).catch(() => {});
    syncAutocatchPairs();
  }
}, 1000);

async function sendLog(guildId, type, logMessage, accToken = null) {
  const guildLogs = currentConfigData.logs[guildId] || {};
  const channelId = guildLogs[type];
  if (channelId) {
    let clientToUse = null;
    if (accToken && runningClients.has(accToken)) clientToUse = runningClients.get(accToken);
    else if (runningClients.size > 0) clientToUse = Array.from(runningClients.values())[0];
    if (clientToUse) {
      const ch = await clientToUse.channels.fetch(channelId).catch(() => null);
      if (ch) await ch.send(logMessage).catch(() => {});
    }
  }
}

function getOrAssignCatcherForMessage(message) {
  if (detectionAssignments.has(message.id)) return detectionAssignments.get(message.id);
  if (currentAutocatchPairs.length === 0) {
    detectionAssignments.set(message.id, null);
    return null;
  }

  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }));
  const msSinceMidnight = now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
  const msPerPart = 86400000 / currentAutocatchPairs.length;
  const pairIndex = Math.floor(msSinceMidnight / msPerPart) % currentAutocatchPairs.length;

  const currentPair = currentAutocatchPairs[pairIndex];
  let assignedAccToken = null;

  if (currentPair[0] === currentPair[1]) {
    assignedAccToken = currentPair[0];
  } else {
    const turnCounter = pairTurnStates.get(pairIndex) || 0;
    assignedAccToken = currentPair[turnCounter % 2];
    pairTurnStates.set(pairIndex, turnCounter + 1);
  }

  detectionAssignments.set(message.id, assignedAccToken);
  const accIdx = currentAccounts.findIndex(a => a.token === assignedAccToken) + 1;
  grinderRef.child("autocatch/current_catcher").set({
    accIndex: accIdx > 0 ? accIdx : assignedAccToken,
    messageId: message.id,
    timestamp: new Date().toISOString()
  }).catch(() => {});

  if (detectionAssignments.size > 100) {
    const firstKey = detectionAssignments.keys().next().value;
    detectionAssignments.delete(firstKey);
  }
  return assignedAccToken;
}

// --- SPAM ENGINE LOOP WITH ORGANIC PACING & AFK BREAKS ---
async function spamSend(token, channelId, text) {
  const client = runningClients.get(token);
  if (!client) return;

  // Respect organic AFK session breaks
  const session = updateAccountSession(token, client);
  if (session.isAfk) return;

  const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  // Brief typing burst for realism
  if (channel.sendTyping && Math.random() < 0.45) {
    await channel.sendTyping().catch(() => {});
    await delay(250 + Math.floor(Math.random() * 450));
  }

  await channel.send(text).then(() => {
    const acc = currentAccounts.find(a => a.token === token);
    if (acc) channelLastActionAcc.set(channelId, acc.index);
  }).catch(() => {});
}

const SPAM_BASE_GAP_MS = 1850; // Increased base interval to avoid rapid velocity triggers
const SPAM_TICK_MS = 50;

function readSpamMessages() {
  try {
    return fs.readFileSync(MESSAGES_FILE, "utf-8").split("\n").filter(l => l.trim());
  } catch (err) {
    return [];
  }
}

setInterval(() => {
  const now = Date.now();
  const spammersByChannel = {};
  for (const guildId in currentConfigData.configs) {
    currentConfigData.configs[guildId].forEach(c => {
      const isPaused = c.paused === true || String(c.paused).toLowerCase() === "true";
      if (c.mode !== "spam" || isPaused) return;

      const chidMatch = String(c.target || "").match(/\d+/);
      if (!chidMatch) return;
      const channelId = chidMatch[0];

      const accToken = c.token || (currentAccounts[c.accIndex - 1] ? currentAccounts[c.accIndex - 1].token : null);
      if (!accToken) return;

      if (!spammersByChannel[channelId]) spammersByChannel[channelId] = [];
      if (!spammersByChannel[channelId].includes(accToken)) spammersByChannel[channelId].push(accToken);
    });
  }

  for (const channelId in spamTurns) {
    if (!spammersByChannel[channelId]) delete spamTurns[channelId];
  }

  for (const channelId in spammersByChannel) {
    const group = spammersByChannel[channelId];
    const state = spamTurns[channelId] || (spamTurns[channelId] = { idx: 0, nextAt: now });

    if (now < state.nextAt) continue;

    // Wide non-uniform jitter + occasional micro-pause (3 to 8 seconds)
    let jitterOffset = Math.floor(gaussianRandom(0, 450));
    if (Math.random() < 0.08) jitterOffset += 3000 + Math.floor(Math.random() * 5000);

    state.nextAt = now + Math.max(1100, SPAM_BASE_GAP_MS + jitterOffset);

    let token = null;
    for (let tries = 0; tries < group.length; tries++) {
      const candidate = group[state.idx % group.length];
      state.idx = (state.idx + 1) % group.length;
      if (runningClients.has(candidate)) { token = candidate; break; }
    }
    if (!token) continue;

    const messages = readSpamMessages();
    if (messages.length === 0) continue;

    spamSend(token, channelId, messages[Math.floor(Math.random() * messages.length)]);
  }
}, SPAM_TICK_MS);

// --- BOT CLIENT ATTACHMENT WITH RESIDENTIAL PROXY & REALISTIC TELEMETRY ---
async function startAccountClient(acc) {
  if (runningClients.has(acc.token) || startingTokens.has(acc.token)) return;

  startingTokens.add(acc.token);
  
  const proxyUrl = process.env.PROXY_URL || acc.proxy || undefined;
  if (proxyUrl) {
    console.log(`[network] Routing Acc #${acc.index} through configured proxy.`);
  } else {
    console.warn(`[WARNING] Acc #${acc.index} has no proxy configured! Running on datacenter IP increases flag risk.`);
  }

  const client = new Client({ 
    checkUpdate: false,
    proxy: proxyUrl,
    ws: {
      properties: {
        browser: "Discord Client",
        os: "Windows",
        device: "Desktop"
      }
    }
  });

  client.on("ready", () => {
    console.log(`[+] Logged in as Acc #${acc.index}: ${client.user.tag}`);
    const targetAcc = currentAccounts.find((a) => a.token === acc.token);
    if (targetAcc) targetAcc.id = client.user.id;
    updateAccountSession(acc.token, client);
    processNameRequests().catch(() => {});
  });

  client.on("messageCreate", async (message) => {
    if (!message.guild) return;
    const guildId = message.guild.id;
    const myConfigs = (currentConfigData.configs[guildId] || []).filter(
      (c) => {
        const isPaused = c.paused === true || String(c.paused).toLowerCase() === "true";
        const configToken = c.token || (currentAccounts[c.accIndex - 1] ? currentAccounts[c.accIndex - 1].token : null);
        return configToken === acc.token && !isPaused;
      }
    );

    // --- COMMAEDIT MODE ---
    if (message.author.id === client.user.id && message.content.includes(",")) {
      if (myConfigs.some(c => c.mode === "commaedit")) {
        await message.edit(message.content.replace(/,/g, `<@${POKETWO_ID}>`)).catch(() => {});
        return;
      }
    }

    // --- DOTCATCH MODE ---
    if (message.author.id === client.user.id && message.content.trim() === ".") {
      if (myConfigs.some(c => c.mode === "dotcatch")) {
        await humanReactionDelay(600, 150, 350);
        await message.channel.send(`<@${POKETWO_ID}> h`).catch(() => {});
        dotcatchWaiters.set(message.channel.id, acc.index);
        return;
      }
    }

    // --- SUCCESS LOGGING ---
    if (message.author.id === POKETWO_ID && message.content.includes("Congratulations <@")) {
      const match = message.content.match(/Congratulations <@!?(\d+)>/);
      if (match && match[1] === client.user.id) {
        const catchAction = recentCatchHistory.get(acc.index);
        if (catchAction && (Date.now() - catchAction.timestamp < 15000)) {
          await sendLog(guildId, catchAction.mode, `🎉 **Success!** Acc #${acc.index} caught a Pokémon!\n${message.url}`, acc.token);
          recentCatchHistory.delete(acc.index);
        }
      }
    }

    // --- CAPTCHA / FLAG DETECTION ---
    if (message.author.id === POKETWO_ID && message.content.toLowerCase().includes("whoa there")) {
      const isTargetedDirectly = message.content.includes(`<@${client.user.id}>`) || message.mentions.has(client.user);
      const lastAttempt = recentCatchAttempts.get(`${message.channel.id}_${acc.index}`);
      const isTargetedByContext = lastAttempt && String(lastAttempt.accIndex) === String(acc.index) && (Date.now() - lastAttempt.timestamp <= 30000); 

      if (isTargetedDirectly || isTargetedByContext) {
        let targetLogGuildId = guildId; 
        for (const configGuildId in currentConfigData.configs) {
          if (currentConfigData.configs[configGuildId].some(c => (c.token === acc.token || String(c.accIndex) === String(acc.index)))) {
            if (currentConfigData.logs[configGuildId]?.["alerts"]) {
              targetLogGuildId = configGuildId;
              break;
            }
          }
        }

        const linkMatch = message.content.match(/https?:\/\/[^\s]+/i);
        const verifyLink = linkMatch ? linkMatch[0] : "Link not found";

        pauseAccountInFirebase(acc.index);
        await sendLog(
          targetLogGuildId, 
          "alerts", 
          `🚨 **Captcha Detected!** Acc #${acc.index} flagged in <#${message.channel.id}>!\n**Verify:** ${verifyLink}`, 
          acc.token
        );
        recentCatchAttempts.delete(`${message.channel.id}_${acc.index}`); 
      }
    }

    // --- DETECTOR BOT HANDLER ---
    if (currentDetectorBots.has(message.author.id)) {
      // Check if account is currently in an organic AFK break
      const session = updateAccountSession(acc.token, client);
      if (session.isAfk) return;

      let fullContent = message.content || "";
      if (message.embeds && message.embeds.length > 0) {
        for (const embed of message.embeds) {
          if (embed.author?.name) fullContent += "\n" + embed.author.name;
          if (embed.title) fullContent += "\n" + embed.title;
          if (embed.description) fullContent += "\n" + embed.description;
          if (embed.fields) {
            for (const field of embed.fields) fullContent += `\n${field.name} ${field.value}`;
          }
        }
      }
      
      const cleanedContent = fullContent.replace(/[*`_]/g, "").replace(/[\u200B-\u200D\uFEFF]/g, "");

      if (cleanedContent.includes("Possible Pokémon:")) {
        const match = cleanedContent.match(/Possible Pokémon:\s*(.*)/i);
        if (match) {
          const waitingAccIndex = dotcatchWaiters.get(message.channel.id);
          if (String(waitingAccIndex) === String(acc.index)) {
            channelLastActionAcc.set(message.channel.id, acc.index);
            const pokemon = match[1].trim();
            await sendCatchCommand(message.channel, pokemon, acc);
            dotcatchWaiters.delete(message.channel.id);
          }
        }
        return;
      }

      const detectedName = extractDetectedName(cleanedContent);
      if (!detectedName) return;

      const nowTs = Date.now();
      const lock = channelDetectLock.get(message.channel.id);
      if (lock && nowTs < lock.until && lock.messageId !== message.id) return;

      const pokemonName = cleanPokemonName(detectedName);   
      const finalCatchName = getBestCatchName(pokemonName); 
      let priorityGroups = { 3: [], 2: [], 1: [] };

      for (const configGuildId in currentConfigData.configs) {
        const globalConfigs = currentConfigData.configs[configGuildId] || [];
        for (const c of globalConfigs) {
          const isPaused = c.paused === true || String(c.paused).toLowerCase() === "true";
          if (c.mode !== "autocatch" || isPaused) continue;

          const cfgAccToken = c.token || (currentAccounts[c.accIndex - 1] ? currentAccounts[c.accIndex - 1].token : null);
          const cfgAcc = currentAccounts.find(a => a.token === cfgAccToken || a.index === c.accIndex);
          const runningClient = cfgAccToken ? runningClients.get(cfgAccToken) : null;
          const cfgAccId = cfgAcc?.id || runningClient?.user?.id || (cfgAccToken === acc.token ? client.user?.id : null);

          const { ids: allowedTargetIds, pokemons: targetPokemons, hasLocations, hasPokemonFilter } = parseAutocatchTarget(c.target);
          const cfgClient = (cfgAccToken === acc.token) ? client : runningClient;
          if (!cfgClient || !cfgClient.guilds.cache.has(message.guild.id)) continue;

          const listenIds = hasLocations ? allowedTargetIds : [configGuildId];
          if (!listenIds.includes(message.guild.id) && !listenIds.includes(message.channel.id)) continue;

          const pingOnly = c.pingOnly === true || String(c.pingOnly).toLowerCase() === "true";
          const needsPing = pingOnly && message.guild.id !== configGuildId;

          const guildExcludes = currentConfigData.excludes[configGuildId] || [];
          const isExcluded = guildExcludes.some(ex => {
            const exName = cleanPokemonName(typeof ex === "string" ? ex : (ex.name || ""));
            if (!exName) return false;
            const xnon = typeof ex === "object" && !!ex.xnon;
            return matchPokemon(pokemonName, exName, xnon) || matchPokemon(finalCatchName, exName, xnon);
          });
          if (isExcluded) continue;

          let priority = 1;
          if (hasPokemonFilter) {
            const matchedPoke = targetPokemons.find(p => p.name === pokemonName);
            if (!matchedPoke) continue;
            priority = matchedPoke.fromJson ? 2 : 3;
          }

          if (needsPing && !isAccountMentioned(message, fullContent, cfgAccId)) continue;
          if (cfgAccToken) priorityGroups[priority].push(cfgAccToken);
        }
      }

      let chosenToken = null;
      if (detectionAssignments.has(message.id)) {
        chosenToken = detectionAssignments.get(message.id);
      } else {
        if (priorityGroups[3].length > 0) {
          const turn = pairTurnStates.get("p3") || 0;
          chosenToken = priorityGroups[3][turn % priorityGroups[3].length];
          pairTurnStates.set("p3", turn + 1);
        } else if (priorityGroups[2].length > 0) {
          const turn = pairTurnStates.get("p2") || 0;
          chosenToken = priorityGroups[2][turn % priorityGroups[2].length];
          pairTurnStates.set("p2", turn + 1);
        } else if (priorityGroups[1].length > 0) {
          // 10% chance to organically "miss" a low-priority spawn so catch rate isn't 100.0%
          if (Math.random() < 0.10) {
            detectionAssignments.set(message.id, null);
            return;
          }
          const assignedToken = getOrAssignCatcherForMessage(message); 
          if (assignedToken && priorityGroups[1].includes(assignedToken)) {
            chosenToken = assignedToken;
          } else {
            const turn = pairTurnStates.get("p1") || 0;
            chosenToken = priorityGroups[1][turn % priorityGroups[1].length];
            pairTurnStates.set("p1", turn + 1);
          }
        }

        if (chosenToken !== null) {
          detectionAssignments.set(message.id, chosenToken);
          channelDetectLock.set(message.channel.id, { until: Date.now() + DETECT_LOCK_MS, messageId: message.id });
          
          const cIdx = currentAccounts.findIndex(a => a.token === chosenToken) + 1;
          grinderRef.child("autocatch/current_catcher").set({
            accIndex: cIdx > 0 ? cIdx : null,
            messageId: message.id,
            timestamp: new Date().toISOString()
          }).catch(() => {});
        }
      }

      if (chosenToken && chosenToken === acc.token) {
        recentCatchHistory.set(acc.index, { mode: "autocatch", timestamp: Date.now() });
        channelLastActionAcc.set(message.channel.id, acc.index);
        
        // Bell-curve reaction delay before starting to type
        await humanReactionDelay(1750, 450, 950); 
        await sendCatchCommand(message.channel, finalCatchName, acc);
      }
    }
  });

  try {
    await client.login(acc.token);
    runningClients.set(acc.token, client);
  } catch (err) {
    console.error(`[-] Failed to login Acc #${acc.index}: ${err.message}`);
  } finally {
    startingTokens.delete(acc.token);
  }
}

async function main() {
  setupFirebaseListener();
  setupNameRequestListener();
  setupUpdater({ db, runningClients });
}

main();