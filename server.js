import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/StringSession.js';
import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit'; // Express rate limiter
import TonConnectSDK from '@tonconnect/sdk'; // Assuming you'll import TonConnect SDK like this

dotenv.config({ path: '/Users/elrohifilmon/Documents/vcs/github.com/elrohi/fanospay2/bot/.env' });


const app = express();

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // max 100 requests per windowMs
  message: 'Too many requests from this IP, please try again after a minute'
});

app.use(limiter); // Apply rate limiter to all routes

// CORS configuration
const corsOptions = {
  origin: process.env.FRONTEND_URL,
  methods: ["GET", "POST"]
};
app.use(cors(corsOptions));
app.use(express.json()); // For parsing application/json

// Telegram Services
const stringSession = new StringSession(process.env.TELEGRAM_SESSION_STRING);
const gramClient = new TelegramClient(
  stringSession,
  parseInt(process.env.TELEGRAM_API_ID),
  process.env.TELEGRAM_API_HASH,
  { connectionRetries: 5 }
);

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID;
const SUBSCRIPTIONS_FILE = path.resolve("subscriptions.json");

// TON Connect Configuration (Assuming TonConnect and TonConnectStorage are defined elsewhere or imported)
const TonConnect = TonConnectSDK; // Use imported TonConnect
const TonConnectStorage = class {}; // Placeholder, replace with actual TonConnectStorage if needed

const connector = new TonConnect({
  manifestUrl: process.env.TONCONNECT_MANIFEST_URL,
  storage: new TonConnectStorage() // Ensure TonConnectStorage is correctly implemented or imported
});

// Subscription Management
async function loadSubscriptions() {
  try {
    const data = await fs.readFile(SUBSCRIPTIONS_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.writeFile(SUBSCRIPTIONS_FILE, "[]");
      return [];
    }
    throw err;
  }
}

async function saveSubscriptions(subscriptions) {
  await fs.writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2));
}

// Channel Management
async function manageChannelAccess(userId, action = 'add') {
  try {
    if (action === 'add') {
      await gramClient.invoke({
        _: "channels.inviteToChannel",
        channel: CHANNEL_ID,
        users: [userId]
      });
    } else {
      await gramClient.invoke({
        _: "channels.banParticipant",
        channel: CHANNEL_ID,
        participant: userId,
        bannedRights: {
          _: "chatBannedRights",
          viewMessages: true,
          sendMessages: true,
          untilDate: Math.floor(Date.now() / 1000) + 86400
        }
      });
    }
    return true;
  } catch (error) {
    console.error(`Channel access error: ${error}`);
    return false;
  }
}

// API Endpoints

// Payment Verification
app.post("/verify-payment", async (req, res) => {
  try {
    const { tgId, txHash, planType, userData } = req.body;
    const subscriptions = await loadSubscriptions();

    // Verify transaction (You'll need to implement getTransactionValue based on txHash)
    const txData = await fetch(`https://tonapi.io/v1/blockchain/transactions/${txHash}`);
    const txJson = await txData.json(); // Parse JSON response
    let txValue = 0;
    if (txJson && txJson[0] && txJson[0].out_msgs && txJson[0].out_msgs[0] && txJson[0].out_msgs[0].value) {
        txValue = parseInt(txJson[0].out_msgs[0].value, 10); // Parse TON value from string to int
    } else {
        throw new Error('Could not parse transaction value from TON API response');
    }

    const tonPrice = await getTonPrice();
    const requiredAmount = planType === '3months' ? 28 : 10;
    const tonAmount = Math.ceil((requiredAmount / tonPrice) * 1e9);


    if (txValue < tonAmount) {
      throw new Error('Insufficient payment');
    }

    // Update subscription
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + (planType === '3months' ? 3 : 1));

    const subData = {
      userid: tgId,
      ...userData,
      packageTitle: `${planType} Plan`,
      subscriptionID: subscriptions.length + 1,
      subscribeddate: new Date().toISOString(),
      end_date: endDate.toISOString(),
      removed: false,
      txHash
    };

    const existingIndex = subscriptions.findIndex(s => s.userid === tgId);
    if (existingIndex > -1) {
      subscriptions[existingIndex] = subData;
    } else {
      subscriptions.push(subData);
    }

    await saveSubscriptions(subscriptions);
    await manageChannelAccess(tgId, 'add');

    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: "Payment verification failed", details: error.message });
  }
});

// TON Price Endpoint
app.get("/get-ton-price", async (req, res) => {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
    const data = await response.json();
    const priceChange = (Math.random() * 4 - 2).toFixed(1);
    return res.json({
      tonPrice: data['the-open-network'].usd,
      priceChange
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch TON price" });
  }
});

// Get User Info Endpoint
app.get("/get-user-info", async (req, res) => {
  try {
    const { tgId } = req.query;
    const user = await bot.telegram.getChat(tgId);

    return res.json({
      username: user.username || user.first_name,
      photo: user.photo?.small_file_id ?
        await bot.telegram.getFileLink(user.photo.small_file_id) :
        'https://pbs.twimg.com/profile_images/1867263226645291008/tGukTtVn_400x400.jpg'
    });
  } catch (error) {
    res.status(404).json({ error: "User not found" });
  }
});

// Disconnect Wallet Endpoint
app.post("/disconnect-wallet", async (req, res) => {
  const { tgId } = req.body;
  const subscriptions = await loadSubscriptions();
  const index = subscriptions.findIndex(s => s.userid === tgId);

  if (index > -1) {
    await manageChannelAccess(tgId, 'remove');
    subscriptions.splice(index, 1);
    await saveSubscriptions(subscriptions);
  }

  return res.json({ success: true });
});

// Bot Commands
bot.command('subscribe', async (ctx) => {
  const authLink = `${process.env.FRONTEND_URL}?tgId=${ctx.from.id}`;
  await ctx.reply(`💰 Premium Channel Access\n\nPay here: ${authLink}`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "1 Month - $10", callback_data: "plan_1month" }],
        [{ text: "3 Months - $28", callback_data: "plan_3months" }]
      ]
    }
  });
});

// Subscription Management Cron
cron.schedule("0 0 * * *", async () => {
  const subscriptions = await loadSubscriptions();
  const now = new Date();

  for (const sub of subscriptions) {
    if (new Date(sub.end_date) < now && !sub.removed) {
      try {
        await manageChannelAccess(sub.userid, 'remove');
        sub.removed = true;
        await saveSubscriptions(subscriptions);
        await bot.telegram.sendMessage(
          sub.userid,
          "Your subscription has expired. Renew at: " + process.env.FRONTEND_URL
        );
      } catch (error) {
        console.error(`Subscription cleanup error: ${error}`);
      }
    }
  }
});

// Server Initialization
async function startServices() {
  try {
    await gramClient.start({ botAuthToken: process.env.TELEGRAM_BOT_TOKEN });
    await bot.launch();

    app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
      console.log(`Bot @${bot.context.botInfo.username} operational`);
    });

  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
}

startServices();