console.log("=== GRINDER ENGINE SCRIPT LAUNCHING ===");

const { Client } = require("discord.js-selfbot-v13");
const fs = require("fs-extra");
const path = require("path");
const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const serviceAccount = require("./firebase_key.json");

// --- FIREBASE SETUP ---
initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://versatile-kl-default-rtdb.firebaseio.com/"
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
          if (typeof item === 'string') pokeVarsSet.add(item.toLowerCase().trim());
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
const startingTokens = new Set(); // Prevent duplicate login race conditions
const dotcatchWaiters = new Map(); 

let currentAutocatchPairs = [];
let cachedActiveAutocatchers = [];
const pairTurnStates = new Map(); 
const detectionAssignments = new Map(); 

let spamTurns = {}; 
const periodicMsgState = new Map(); 

let recentCatchHistory = new Map(); 
let channelLastActionAcc = new Map(); 
const recentCatchAttempts = new Map(); 

// --- DURATION & DELAY UTILITIES ---
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

// --- POKEMON CLEANING & MATCHING UTILITIES ---
function cleanPokemonName(name) {
  return name
    .replace(/[\p{Emoji}\p{Extended_Pictographic}]/gu, "")
    .toLowerCase()
    .replace(/é/g, "e")
    .trim();
}

function getBestCatchName(pokemonName) {
  const cleaned = cleanPokemonName(pokemonName);
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return cleaned;

  const matchingWords = words.filter(w => pokeVarsSet.has(w));
  if (matchingWords.length > 0) {
    return matchingWords[matchingWords.length - 1];
  }
  return cleaned;
}

function findFirstPokemonNameInMessage(cleanedContent) {
  if (!cleanedContent || pokeVarsSet.size === 0) return null;
  
  const lowerContent = cleanedContent.toLowerCase();
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
        if (
          !firstMatch ||
          index < firstMatch.index ||
          (index === firstMatch.index && target.length > firstMatch.name.length)
        ) {
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
  if (message.mentions && message.mentions.users && message.mentions.users.has(targetAccId)) {
    return true;
  }
  if (fullContent) {
    if (fullContent.includes(targetAccId) || 
        fullContent.includes(`<@${targetAccId}>`) || 
        fullContent.includes(`<@!${targetAccId}>`)) {
      return true;
    }
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

// --- TYPO & CATCH UTILITIES ---
function makeTypo(name) {
  if (name.length < 2) return name;
  const arr = name.split("");
  const idx = Math.floor(Math.random() * (arr.length - 1));
  const temp = arr[idx];
  arr[idx] = arr[idx + 1];
  arr[idx + 1] = temp;
  return arr.join("");
}

async function sendCatchCommand(channel, finalCatchName, acc) {
  recentCatchAttempts.set(`${channel.id}_${acc.index}`, {
    accIndex: acc.index,
    token: acc.token,
    timestamp: Date.now()
  });

  if (Math.random() < 0.1) {
    const typoedName = makeTypo(finalCatchName);
    const sentMsg = await channel.send(`<@${POKETWO_ID}> c ${typoedName}`).catch(() => null);
    if (sentMsg) {
      await delay(300);
      await sentMsg.edit(`<@${POKETWO_ID}> c ${finalCatchName}`).catch(() => {});
    }
  } else {
    await channel.send(`<@${POKETWO_ID}> c ${finalCatchName}`).catch(() => {});
  }
}

// --- FIREBASE SYNC & CLIENT MANAGEMENT ---
async function updateRunningAccounts(rawTokens) {
  const activeTokens = new Set(rawTokens);

  for (const [token, client] of runningClients) {
    if (!activeTokens.has(token)) {
      console.log(`[-] Account token removed. Stopping client...`);
      client.destroy();
      runningClients.delete(token);
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
  
  if (JSON.stringify(currentActiveTokens) === JSON.stringify(cachedActiveAutocatchers)) {
    return;
  }

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

  const indexPairs = pairs.map(pair => {
     return pair.map(tok => {
         const accIdx = currentAccounts.findIndex(a => a.token === tok) + 1;
         return accIdx > 0 ? accIdx : tok;
     });
  });

  grinderRef.child("autocatch/pairs").set(indexPairs).catch(() => {});
  fs.outputJsonSync(AUTOCATCH_FILE, {
    pairs: pairs, 
    active_autocatchers: currentActiveTokens
  });
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
      if (Array.isArray(dbots[guildId])) {
        dbots[guildId].forEach(botId => currentDetectorBots.add(botId));
      }
    }
    
    loadPokeVars();

    console.log("🔄 Real-time Firebase sync received.");

    let needsMigration = false;
    const accountsToRestart = new Set();
    
    for (const guildId in newConfigs) {
        const nCfgs = newConfigs[guildId] || [];
        const oCfgs = currentConfigData.configs[guildId] || [];
        
        nCfgs.forEach((newC, i) => {
            if (!newC.token && newC.accIndex) {
                const t = accountsList[newC.accIndex - 1];
                if (t) {
                    newC.token = t;
                    needsMigration = true;
                }
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

    if (needsMigration) {
        grinderRef.child("configs").set(newConfigs).catch(() => {});
    }
    currentConfigData.configs = newConfigs;

    await updateRunningAccounts(accountsList);
    syncAutocatchPairs();

    for (const token of accountsToRestart) {
        if (runningClients.has(token)) {
            console.log(`[!] Spam configuration paused. Logging out and logging back in to instantly clear queue...`);
            const client = runningClients.get(token);
            client.destroy();
            runningClients.delete(token);
            
            const acc = currentAccounts.find(a => a.token === token);
            if (acc) {
                setTimeout(() => {
                  if (!runningClients.has(acc.token) && !startingTokens.has(acc.token)) {
                    startAccountClient(acc);
                  }
                }, 1500); 
            }
        }
    }
  });
}

// --- ID NAME LOOKUP (guild / channel names requested by the Python bot) ---
const nameRequests = new Map();   // id -> { accIndex, requestedAt }
let processingNameRequests = false;

async function lookupIdName(client, id) {
  const guild = client.guilds.cache.get(id);
  if (guild) return { type: "guild", name: guild.name };

  let channel = client.channels.cache.get(id);
  if (!channel) channel = await client.channels.fetch(id).catch(() => null);
  if (channel && channel.name) {
    return { type: "channel", name: channel.name, guildName: channel.guild ? channel.guild.name : null };
  }
  return null;
}

async function processNameRequests() {
  if (processingNameRequests || nameRequests.size === 0) return;

  const readyClients = Array.from(runningClients.entries()).filter(([, c]) => c.isReady && c.isReady());
  if (readyClients.length === 0) return; // retried when a client becomes ready

  processingNameRequests = true;
  try {
    for (const [id, req] of Array.from(nameRequests.entries())) {
      // Try the config's own (autocatch) account first, then every other logged-in account.
      const preferredToken = currentAccounts[(req.accIndex || 0) - 1]?.token;
      const ordered = [
        ...readyClients.filter(([tok]) => tok === preferredToken),
        ...readyClients.filter(([tok]) => tok !== preferredToken)
      ];

      let result = null;
      for (const [, client] of ordered) {
        try {
          result = await lookupIdName(client, id);
        } catch (_) {
          result = null;
        }
        if (result) break;
      }

      // Firebase drops null values, so an unresolved ID is stored as just { checkedAt }.
      const payload = { checkedAt: Date.now() };
      if (result) {
        payload.type = result.type;
        payload.name = result.name;
        if (result.guildName) payload.guildName = result.guildName;
      }

      await grinderRef.child("id_names").child(id).set(payload).catch(() => {});
      await grinderRef.child("name_requests").child(id).remove().catch(() => {});
      nameRequests.delete(id);
      console.log(`🔎 Name lookup ${id}: ${result ? `${result.type} "${result.name}"` : "not found"}`);
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
      if ((accIndex === null || String(cfgAccIdx) === String(accIndex)) && 
          ["autocatch", "spam"].includes(c.mode)) {
        c.paused = true;
        c.pauseUntil = pauseUntil;
        modified = true;
      }
    });
  }
  
  if (modified) {
    const targetStr = accIndex === null ? "ALL accounts" : `Acc #${accIndex}`;
    const durStr = durationMs ? `for ${formatDuration(durationMs)}` : "indefinitely";
    console.log(`⏸️ Pausing ${targetStr} in Firebase ${durStr}.`);
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
        modified = true;
        
        const cfgAccIdx = c.token ? (currentAccounts.findIndex(a => a.token === c.token) + 1) : c.accIndex;
        console.log(`⏰ Temporary pause expired for Acc #${cfgAccIdx}. Auto-resumed.`);
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

    if (accToken && runningClients.has(accToken)) {
      clientToUse = runningClients.get(accToken);
    } else if (runningClients.size > 0) {
      clientToUse = Array.from(runningClients.values())[0];
    }

    if (clientToUse) {
      const ch = await clientToUse.channels.fetch(channelId).catch(() => null);
      if (ch) await ch.send(logMessage).catch(() => {});
    }
  }
}

// --- ATOMIC TURN DEDUPLICATION ---
function getOrAssignCatcherForMessage(message) {
  if (detectionAssignments.has(message.id)) {
    return detectionAssignments.get(message.id);
  }

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

// --- SPAM ENGINE LOOP ---
setInterval(() => {
  const messages = fs.readFileSync(MESSAGES_FILE, "utf-8").split("\n").filter(l => l.trim());
  if (messages.length === 0) return;

  const spammersByChannel = {};
  for (const guildId in currentConfigData.configs) {
    currentConfigData.configs[guildId].forEach(c => {
      const isPaused = c.paused === true || String(c.paused).toLowerCase() === "true";
      if (c.mode === "spam" && !isPaused && c.target) {
        if (!spammersByChannel[c.target]) spammersByChannel[c.target] = [];
        
        const accToken = c.token || (currentAccounts[c.accIndex - 1] ? currentAccounts[c.accIndex - 1].token : null);
        if (accToken) spammersByChannel[c.target].push(accToken);
      }
    });
  }

  for (const channelId in spammersByChannel) {
    const accTokens = spammersByChannel[channelId];
    if (accTokens.length === 0) continue;

    if (!spamTurns[channelId]) spamTurns[channelId] = 0;
    const currentToken = accTokens[spamTurns[channelId] % accTokens.length];
    spamTurns[channelId]++;

    if (runningClients.has(currentToken)) {
      const client = runningClients.get(currentToken);
      const channel = client.channels.cache.get(channelId);
      if (channel) {
        const msg = messages[Math.floor(Math.random() * messages.length)];
        channel.send(msg).then(() => {
          const acc = currentAccounts.find(a => a.token === currentToken);
          if (acc) channelLastActionAcc.set(channelId, acc.index);
        }).catch(() => {});
      }
    }
  }
}, 1000);

// --- PERIODIC MESSAGE ENGINE LOOP ---
setInterval(() => {
  const now = Date.now();

  for (const guildId in currentConfigData.configs) {
    currentConfigData.configs[guildId].forEach(c => {
      const isPaused = c.paused === true || String(c.paused).toLowerCase() === "true";
      if (c.mode === "periodicmsg" && !isPaused && c.target) {
        const parts = c.target.split(';');
        if (parts.length >= 4) {
          const channelId = parts[0].trim();
          const messageText = parts[1].trim();
          const t1 = parseInt(parts[2].trim());
          const t2 = parseInt(parts[3].trim());

          if (isNaN(t1) || isNaN(t2)) return;

          const accToken = c.token || (currentAccounts[c.accIndex - 1] ? currentAccounts[c.accIndex - 1].token : null);
          const key = `${accToken}_${channelId}_${messageText}`;
          let state = periodicMsgState.get(key);
          
          if (!state) {
            state = { nextRun: now }; 
          }

          if (now >= state.nextRun) {
            if (accToken && runningClients.has(accToken)) {
              const client = runningClients.get(accToken);
              const channel = client.channels.cache.get(channelId);
              if (channel) {
                channel.send(messageText).then(() => {
                  const acc = currentAccounts.find(a => a.token === accToken);
                  if (acc) channelLastActionAcc.set(channelId, acc.index);
                }).catch(() => {});
              }
            }

            const minMs = Math.min(t1, t2) * 1000;
            const maxMs = Math.max(t1, t2) * 1000;
            const waitMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
            
            periodicMsgState.set(key, { nextRun: now + waitMs });
          }
        }
      }
    });
  }
}, 1000);

// --- BOT CLIENT ATTACHMENT ---
async function startAccountClient(acc) {
  if (runningClients.has(acc.token) || startingTokens.has(acc.token)) return;

  startingTokens.add(acc.token);
  const client = new Client({ checkUpdate: false });

  client.on("ready", () => {
    console.log(`[+] Logged in as Acc #${acc.index}: ${client.user.tag}`);
    const targetAcc = currentAccounts.find((a) => a.token === acc.token);
    if (targetAcc) targetAcc.id = client.user.id;
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

    // --- DOTCATCH MODE TRIGGER ---
    if (message.author.id === client.user.id && message.content.trim() === ".") {
      if (myConfigs.some(c => c.mode === "dotcatch")) {
        await message.channel.send(`<@${POKETWO_ID}> h`).catch(() => {});
        dotcatchWaiters.set(message.channel.id, acc.index);
        return;
      }
    }

    // --- CATCH SUCCESS LOGGING ---
    if (message.author.id === POKETWO_ID && message.content.includes("Congratulations <@")) {
      const match = message.content.match(/Congratulations <@!?(\d+)>/);
      if (match && match[1] === client.user.id) {
        const catchAction = recentCatchHistory.get(acc.index);
        
        if (catchAction && (Date.now() - catchAction.timestamp < 15000)) {
          const modeUsed = catchAction.mode;
          await sendLog(
            guildId,
            modeUsed, 
            `🎉 **Success!** Acc #${acc.index} (<@${client.user.id}>) caught a Pokémon!\n${message.url}`, 
            acc.token
          );
          recentCatchHistory.delete(acc.index);
        }
      }
    }

    // --- CAPTCHA DETECTED -> PAUSE INDEFINITELY & ALERT ---
    if (message.author.id === POKETWO_ID && message.content.toLowerCase().includes("whoa there")) {
      const isTargetedDirectly = message.content.includes(`<@${client.user.id}>`) || message.mentions.has(client.user);
      
      const lastAttempt = recentCatchAttempts.get(`${message.channel.id}_${acc.index}`);
      const isTargetedByContext = lastAttempt && 
                                  String(lastAttempt.accIndex) === String(acc.index) && 
                                  (Date.now() - lastAttempt.timestamp <= 30000); 

      if (isTargetedDirectly || isTargetedByContext) {
        let targetLogGuildId = guildId; 
        for (const configGuildId in currentConfigData.configs) {
          const hasConfigForAcc = currentConfigData.configs[configGuildId].some(
            c => (c.token === acc.token || String(c.accIndex) === String(acc.index))
          );
          
          if (hasConfigForAcc && currentConfigData.logs[configGuildId] && currentConfigData.logs[configGuildId]["alerts"]) {
            targetLogGuildId = configGuildId;
            break; 
          }
        }

        const linkMatch = message.content.match(/https?:\/\/[^\s]+/i);
        const verifyLink = linkMatch ? linkMatch[0] : "Link not found";

        pauseAccountInFirebase(acc.index);

        await sendLog(
          targetLogGuildId, 
          "alerts", 
          `🚨 **Captcha Detected!** Acc #${acc.index} (<@${client.user.id}>) got flagged in <#${message.channel.id}>!\n` +
          `**Message Link:** ${message.url}\n` +
          `**Verify Link:** ${verifyLink}\n\n` +
          `*Type \`!r\` after completing verification to resume.*`, 
          acc.token
        );

        recentCatchAttempts.delete(`${message.channel.id}_${acc.index}`); 
      }
    }

    // --- DETECTOR BOT HANDLER ---
    if (currentDetectorBots.has(message.author.id)) {
      let fullContent = message.content || "";
      if (message.embeds && message.embeds.length > 0) {
        for (const embed of message.embeds) {
          if (embed.author && embed.author.name) fullContent += "\n" + embed.author.name;
          if (embed.title) fullContent += "\n" + embed.title;
          if (embed.description) fullContent += "\n" + embed.description;
          if (embed.fields) {
            for (const field of embed.fields) {
              fullContent += `\n${field.name} ${field.value}`;
            }
          }
        }
      }
      
      const cleanedContent = fullContent.replace(/[*`_]/g, "").replace(/[\u200B-\u200D\uFEFF]/g, "");

      // --- DOTCATCH HINT HANDLER ---
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

      // --- AUTOCATCH ENGINE LOGIC ---
      let detectedName = findFirstPokemonNameInMessage(cleanedContent);

      if (!detectedName) {
        const match = cleanedContent.match(/^\s*([^:]+?):\s*\d+(?:\.\d+)?%/m);
        if (match) {
          detectedName = match[1].trim();
        }
      }

      if (!detectedName) return;

      const pokemonName = cleanPokemonName(detectedName);
      const finalCatchName = getBestCatchName(pokemonName);

      let priorityGroups = { 3: [], 2: [], 1: [] };

      for (const configGuildId in currentConfigData.configs) {
        const globalConfigs = currentConfigData.configs[configGuildId] || [];
        
        for (const c of globalConfigs) {
          const isPaused = c.paused === true || String(c.paused).toLowerCase() === "true";
          if (c.mode === "autocatch" && !isPaused) {

            const cfgAccToken = c.token || (currentAccounts[c.accIndex - 1] ? currentAccounts[c.accIndex - 1].token : null);
            const cfgAcc = currentAccounts.find(a => a.token === cfgAccToken || a.index === c.accIndex);
            const runningClient = cfgAccToken ? runningClients.get(cfgAccToken) : null;
            const cfgAccId = cfgAcc?.id || runningClient?.user?.id || (cfgAccToken === acc.token ? client.user?.id : null);

            let allowedTargetIds = [];
            let targetPokemons = [];
            let hasExplicitLocations = false;

            if (c.target) {
              const parts = c.target.split(',').map(p => p.trim()).filter(Boolean);
              for (const part of parts) {
                if (/^\d+$/.test(part)) {
                  allowedTargetIds.push(part);
                  hasExplicitLocations = true;
                } else if (part.toLowerCase().endsWith('.json')) {
                  let jsonPath = path.join(DATA_DIR, "targetcatch", part);
                  if (!fs.existsSync(jsonPath)) jsonPath = path.join(DATA_DIR, part);
                  if (!fs.existsSync(jsonPath)) jsonPath = path.join(__dirname, part);
                  
                  try {
                    if (fs.existsSync(jsonPath)) {
                      const jsonData = fs.readJsonSync(jsonPath);
                      const list = Array.isArray(jsonData) ? jsonData : (jsonData.pokemon || []);
                      list.forEach(pName => {
                        if (typeof pName === 'string') {
                          targetPokemons.push({ name: pName.trim(), fromJson: true });
                        }
                      });
                    }
                  } catch (e) {}
                } else {
                  targetPokemons.push({ name: part, fromJson: false });
                }
              }
            }

            // Cross-server catch logic: a config only reaches outside its own server if it
            // has explicit location IDs. A config with no IDs stays locked to its home server.
            const isCrossServer = (configGuildId !== message.guild.id);
            if (isCrossServer) {
              if (!hasExplicitLocations) continue;
              const isMentioned = isAccountMentioned(message, fullContent, cfgAccId);
              if (!isMentioned) {
                continue;
              }
            } else {
              if (hasExplicitLocations) {
                const locationMatch = allowedTargetIds.includes(message.guild.id) || allowedTargetIds.includes(message.channel.id);
                if (!locationMatch) continue;
              }
            }

            let isExcluded = false;
            const guildExcludes = currentConfigData.excludes[configGuildId] || [];
            for (const ex of guildExcludes) {
              const exName = typeof ex === 'string' ? ex : ex.name;
              if (matchPokemon(pokemonName, exName) || matchPokemon(finalCatchName, exName)) {
                isExcluded = true;
                break;
              }
            }
            if (isExcluded) continue;

            let priority = 1;
            let matched = false;

            if (targetPokemons.length > 0) {
              const matchedPoke = targetPokemons.find(p => matchPokemon(pokemonName, p.name) || matchPokemon(finalCatchName, p.name));
              if (matchedPoke) {
                matched = true;
                priority = matchedPoke.fromJson ? 2 : 3;
              }
            } else {
              matched = true;
              priority = 1;
            }

            if (matched) {
              if (cfgAccToken) priorityGroups[priority].push(cfgAccToken);
            }
          }
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
          
          const cIdx = currentAccounts.findIndex(a => a.token === chosenToken) + 1;
          grinderRef.child("autocatch/current_catcher").set({
            accIndex: cIdx > 0 ? cIdx : null,
            messageId: message.id,
            timestamp: new Date().toISOString()
          }).catch(() => {});

          if (detectionAssignments.size > 100) {
            const firstKey = detectionAssignments.keys().next().value;
            detectionAssignments.delete(firstKey);
          }
        }
      }

      if (chosenToken && chosenToken === acc.token) {
        recentCatchHistory.set(acc.index, { mode: "autocatch", timestamp: Date.now() });
        channelLastActionAcc.set(message.channel.id, acc.index);
        
        await delay(Math.floor(Math.random() * 500) + 1000); 
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

// --- STARTUP ---
async function main() {
  setupFirebaseListener();
  setupNameRequestListener();
}

main();