const { Client } = require("discord.js-selfbot-v13");

const accounts = [
  { index: 1, token: "YOUR_TOKEN_1_HERE" },
  { index: 2, token: "YOUR_TOKEN_2_HERE" }
];

const runningClients = new Map();

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function startAccountClient(acc) {
  if (runningClients.has(acc.token)) return;

  const client = new Client({ checkUpdate: false });

  client.on("ready", () => {
    console.log(`[+] Logged in as Acc #${acc.index}: ${client.user.tag}`);
  });

  client.on("messageCreate", async (message) => {
    if (!message.guild) return;

    if (message.author.id === client.user.id) {
      if (message.content.trim() === "!ping") {
        await message.edit("Pong!").catch(() => {});
        return;
      }
    }

    const TARGET_USER_IDS = ["123456789012345678"];
    if (TARGET_USER_IDS.includes(message.author.id)) {
      if (message.content.includes("Trigger Keyword")) {
        const randomWaitMs = Math.floor(Math.random() * 1500) + 1000;
        await delay(randomWaitMs);

        await message.channel.send("Response action executed!").catch(() => {});
      }
    }
  });

  await client.login(acc.token).catch((err) => {
    console.error(`[-] Failed to login Acc #${acc.index}: ${err.message}`);
  });

  runningClients.set(acc.token, client);
}

async function main() {
  console.log("=== MULTI-ACCOUNT SELFBOT ENGINE LAUNCHING ===");
  
  for (const acc of accounts) {
    await startAccountClient(acc);
  }
}

main();