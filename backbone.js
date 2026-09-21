const { Client } = require("discord.js-selfbot-v13");

// --- CONFIGURATION ---
// Add as many account tokens as needed
const accounts = [
  { index: 1, token: "YOUR_TOKEN_1_HERE" },
  { index: 2, token: "YOUR_TOKEN_2_HERE" }
];

// --- IN-MEMORY CACHE ---
const runningClients = new Map(); // Maps token -> Client instance

// --- UTILITY FUNCTIONS ---
function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// --- CLIENT SETUP & ATTACHMENT ---
async function startAccountClient(acc) {
  // Prevent duplicate logins for the same token
  if (runningClients.has(acc.token)) return;

  const client = new Client({ checkUpdate: false });

  // --- EVENT: READY ---
  client.on("ready", () => {
    console.log(`[+] Logged in as Acc #${acc.index}: ${client.user.tag}`);
    // You can initialize account-specific background loops (like your spam/periodic engines) here
  });

  // --- EVENT: MESSAGE CREATE ---
  client.on("messageCreate", async (message) => {
    // Optional: Restrict bot to servers only (ignore DMs)
    if (!message.guild) return;

    // 1. SELF-TRIGGERED ENGINE (Listen to your own messages)
    if (message.author.id === client.user.id) {
      // Example: Edit a message command into something else
      if (message.content.trim() === "!ping") {
        await message.edit("Pong!").catch(() => {});
        return;
      }
    }

    // 2. TARGET DETECTION ENGINE (Listen to specific users or bots)
    const TARGET_USER_IDS = ["123456789012345678"]; // Replace with target user/bot IDs
    if (TARGET_USER_IDS.includes(message.author.id)) {
        
        // Example: Reacting to a specific keyword
        if (message.content.includes("Trigger Keyword")) {
            
            // Add an artificial delay to mimic human behavior
            const randomWaitMs = Math.floor(Math.random() * 1500) + 1000;
            await delay(randomWaitMs);

            await message.channel.send("Response action executed!").catch(() => {});
        }
    }
  });

  // --- ERROR HANDLING & LOGIN ---
  await client.login(acc.token).catch((err) => {
    console.error(`[-] Failed to login Acc #${acc.index}: ${err.message}`);
  });

  // Cache the client instance so it can be managed/destroyed later if needed
  runningClients.set(acc.token, client);
}

// --- STARTUP SEQUENCE ---
async function main() {
  console.log("=== MULTI-ACCOUNT SELFBOT ENGINE LAUNCHING ===");
  
  // Initialize and start all configured accounts
  for (const acc of accounts) {
    await startAccountClient(acc);
  }
  
}

main();
