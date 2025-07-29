// --- LOAD LIBRARIES ---
require('dotenv').config();
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const { MongoClient } = require('mongodb');
const axios = require('axios');

// --- CORE BOT CONFIGURATION ---
const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const CHANNEL_USERNAME = "@ToxicBack2025";
const ADMIN_IDS = [7392785352]; // Your admin ID
const SUPPORT_ADMIN = "@CDMAXX";

// --- CONSTANTS ---
const INITIAL_CREDITS = 2;
const REFERRAL_CREDIT = 1;

// --- DATABASE SETUP ---
if (!TOKEN || !MONGO_URI) {
    console.error("FATAL ERROR: BOT_TOKEN or MONGO_URI is not set in environment variables!");
    process.exit(1);
}
const client = new MongoClient(MONGO_URI);
const db = client.db("ToxicBotDB");
const usersCollection = db.collection("users");
console.log("Attempting to connect to MongoDB...");
client.connect().then(() => console.log("MongoDB connected successfully!")).catch(err => {
    console.error("MongoDB connection failed:", err);
    process.exit(1);
});

// --- SCENES SETUP FOR CONVERSATIONAL COMMANDS ---

const addCreditWizard = new Scenes.WizardScene(
    'add_credit_wizard',
    async (ctx) => {
        await ctx.reply("👤 Please send the User ID of the recipient.\n\nType /cancel to abort.");
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const targetId = parseInt(ctx.message.text, 10);
        if (isNaN(targetId)) {
            return ctx.reply("❗️Invalid ID format. Please send numbers only or type /cancel.");
        }
        const userExists = await usersCollection.findOne({ _id: targetId });
        if (!userExists) {
            return ctx.reply("⚠️ User not found. Please check the ID and try again, or type /cancel.");
        }
        ctx.wizard.state.targetId = targetId;
        await ctx.reply(`✅ User \`${targetId}\` found. Now, please send the amount of credits to add.`, { parse_mode: 'Markdown' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const amount = parseInt(ctx.message.text, 10);
        if (isNaN(amount) || amount <= 0) {
            return ctx.reply("❗️Invalid amount. Please send a positive number or type /cancel.");
        }
        const { targetId } = ctx.wizard.state;
        await usersCollection.updateOne({ _id: targetId }, { $inc: { credits: amount } });
        await ctx.reply(`✅ Success! Added ${amount} credits to user ${targetId}.`, getMainMenuKeyboard(ctx.from.id));
        try {
            await ctx.telegram.sendMessage(targetId, `🎉 An administrator has added *${amount} credits* to your account!`, { parse_mode: 'Markdown' });
        } catch (e) {
            console.error(`Failed to notify user ${targetId} about credits:`, e);
        }
        return ctx.scene.leave();
    }
);
addCreditWizard.command('cancel', async (ctx) => {
    await ctx.reply("🔹 Action has been cancelled.", getMainMenuKeyboard(ctx.from.id));
    return ctx.scene.leave();
});

const broadcastScene = new Scenes.BaseScene('broadcast_scene');
broadcastScene.enter(ctx => ctx.reply("📢 Please send the message to broadcast.\n\nType /cancel to abort."));
broadcastScene.command('cancel', async (ctx) => {
    await ctx.reply("🔹 Action has been cancelled.", getMainMenuKeyboard(ctx.from.id));
    return ctx.scene.leave();
});
broadcastScene.on('text', async (ctx) => {
    const msg = ctx.message.text;
    const usersCursor = usersCollection.find({}, { projection: { _id: 1 } });
    const userIds = await usersCursor.map(user => user._id).toArray();
    
    await ctx.reply(`⏳ Broadcasting your message to ${userIds.length} users...`);
    let successCount = 0, failureCount = 0;
    for (const uid of userIds) {
        try {
            await ctx.telegram.sendMessage(uid, msg);
            successCount++;
        } catch (e) {
            failureCount++;
        }
    }
    await ctx.reply(`📢 *Broadcast Complete!*\n✅ Sent: ${successCount}\n❌ Failed: ${failureCount}`, { parse_mode: 'Markdown', ...getMainMenuKeyboard(ctx.from.id) });
    return ctx.scene.leave();
});

// --- BOT INITIALIZATION AND MIDDLEWARE ---
const stage = new Scenes.Stage([addCreditWizard, broadcastScene]);
const bot = new Telegraf(TOKEN);
bot.use(session());
bot.use(stage.middleware());

// --- HELPER FUNCTIONS ---
const getMainMenuKeyboard = (userId) => {
    const keyboard = [[KeyboardButton("Refer & Earn 🎁"), KeyboardButton("Buy Credits 💰")], [KeyboardButton("My Account 📊"), KeyboardButton("Help ❓")]];
    if (ADMIN_IDS.includes(userId)) {
        keyboard.push([KeyboardButton("Add Credit 👤"), KeyboardButton("Broadcast 📢")], [KeyboardButton("Member Status 👥")]);
    }
    // THE FIX: Always ensure the keyboard is a proper Markup object
    return Markup.keyboard(keyboard).resize();
};

const formatRealRecordAsMessage = (record, index, total) => {
    const rawAddress = record.address || 'N/A';
    const cleanedParts = rawAddress.replace(/!!/g, '!').split('!').map(p => p.trim()).filter(Boolean);
    const formattedAddress = cleanedParts.join(', ');
    return `📊 *Record ${index + 1} of ${total}*\n` + `➖➖➖➖➖➖➖➖➖➖\n` + `👤 *Name:* \`${record.name || 'N/A'}\`\n` + `👨 *Father's Name:* \`${record.fname || 'N/A'}\`\n` + `📱 *Mobile:* \`${record.mobile || 'N/A'}\`\n` + `🏠 *Address:* \`${formattedAddress}\`\n` + `📡 *Circle:* \`${record.circle || 'N/A'}\``;
};

// --- MIDDLEWARE: FORCE CHANNEL JOIN ---
bot.use(async (ctx, next) => {
    if (ctx.scene && ctx.scene.current) return next();
    const userId = ctx.from.id;
    if (ADMIN_IDS.includes(userId)) return next();
    try {
        const chatMember = await ctx.telegram.getChatMember(CHANNEL_USERNAME, userId);
        if (!['member', 'administrator', 'creator'].includes(chatMember.status)) {
            return ctx.reply(`❗️ **Access Denied**\n\nTo use this bot, you must join our official channel.\nPlease join 👉 ${CHANNEL_USERNAME} and then press /start.`, { parse_mode: 'HTML' });
        }
    } catch (error) {
        return ctx.reply("⛔️ Error verifying channel membership. Please contact support.");
    }
    return next();
});

// --- COMMAND AND BUTTON HANDLERS ---
bot.start(async (ctx) => {
    const user = ctx.from, userId = user.id;
    let userDoc = await usersCollection.findOne({ _id: userId });
    if (!userDoc) {
        if (ctx.startPayload) {
            const referrerId = parseInt(ctx.startPayload, 10);
            if (!isNaN(referrerId) && referrerId !== userId && await usersCollection.findOne({ _id: referrerId })) {
                await usersCollection.updateOne(
                    { _id: referrerId }, 
                    { $inc: { credits: REFERRAL_CREDIT, referrals: 1, credits_earned: REFERRAL_CREDIT } }
                );
                const refDoc = await usersCollection.findOne({ _id: referrerId });
                try { await ctx.telegram.sendMessage(referrerId, `🎉 *1 Referral Received!*\nYour new balance is now *${refDoc.credits} credits*.`, { parse_mode: 'Markdown' }); } catch (e) {}
            }
        }
        let adminNote = `🎉 New Member Alert!\nName: ${user.first_name}\nProfile: [${userId}](tg://user?id=${userId})`;
        if (user.username) adminNote += `\nUsername: @${user.username}`;
        for (const adminId of ADMIN_IDS) {
            try { await ctx.telegram.sendMessage(adminId, adminNote, { parse_mode: 'Markdown' }); } catch (e) {}
        }
        const newUser = { _id: userId, first_name: user.first_name, username: user.username, credits: INITIAL_CREDITS, searches: 0, join_date: new Date(), referrals: 0, credits_earned: 0 };
        await usersCollection.insertOne(newUser);
        await ctx.reply(`🎉 Welcome aboard, ${user.first_name}!\n\nAs a new member, you've received *${INITIAL_CREDITS} free credits*.`, { parse_mode: 'Markdown' });
        userDoc = newUser;
    }
    const welcomeMsg = `🎯 **Welcome**\n\n` +
                       `🔍 Advanced OSINT Multi-Search Bot\n\n` +
                       `*What you can search?*\n` +
                       `📱 Phone Number\n` +
                       `📧 Email\n` +
                       `🆔 Aadhar\n` +
                       `🔍 DNS Lookup (Free)\n` +
                       `🌐 IP Info (Free)\n\n` +
                       `💳 **Your Credits:** ${userDoc.credits}\n` +
                       `📊 **Total Searches:** ${userDoc.searches}\n` +
                       `📅 **Member Since:** ${new Date(userDoc.join_date).toLocaleDateString()}`;
    // THE FIX: Always use ctx.reply with the keyboard object as the second argument
    await ctx.reply(welcomeMsg, {
        parse_mode: 'Markdown',
        ...getMainMenuKeyboard(userId)
    });
});

bot.hears("My Account 📊", async (ctx) => {
    const userDoc = await usersCollection.findOne({ _id: ctx.from.id });
    if (!userDoc) return ctx.reply("Please press /start to register.");
    const accountMsg = `🎯 *Welcome, ${ctx.from.first_name}!*` + `\n\n💳 *Your Credits:* ${userDoc.credits}` + `\n📊 *Total Searches:* ${userDoc.searches}` + `\n🗓️ *Member Since:* ${new Date(userDoc.join_date).toLocaleDateString()}`;
    // THE FIX: Always reply with the keyboard to keep it persistent
    await ctx.reply(accountMsg, { parse_mode: 'Markdown', ...getMainMenuKeyboard(ctx.from.id) });
});

bot.hears("Help ❓", (ctx) => {
    const helpText = `❓ *Help & Support Center*\n\n` + `🔍 *How to Use:*\n• Send a phone number to get its report.\n• Each search costs 1 credit.\n\n` + `🎁 *Referral Program:*\n• Get ${REFERRAL_CREDIT} credit per successful referral.\n\n` + `👤 *Support:* ${SUPPORT_ADMIN}`;
    ctx.reply(helpText, { parse_mode: 'Markdown', ...getMainMenuKeyboard(ctx.from.id) });
});

bot.hears("Refer & Earn 🎁", async (ctx) => {
    const userDoc = await usersCollection.findOne({ _id: ctx.from.id });
    if (!userDoc) return ctx.reply("Please press /start to register first.");
    const referralLink = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
    const referralMsg = `🎁 **Refer & Earn Credits**\n\n` + `📊 *Your Performance:*\n` + `👥 Total Referrals: ${userDoc.referrals || 0}\n` + `💰 Credits Earned: ${userDoc.credits_earned || 0}\n\n` + `💡 *How It Works:*\n` + `• Share your referral link with friends\n` + `• They get ${INITIAL_CREDITS} free credits when joining\n` + `• You earn ${REFERRAL_CREDIT} credit for each successful referral\n\n` + `📱 *Your Referral Link:*\n` + `\`${referralLink}\`\n\n` + `🚀 Start sharing to earn unlimited credits!`;
    await ctx.reply(referralMsg, { parse_mode: 'Markdown', ...getMainMenuKeyboard(ctx.from.id) });
});

bot.hears("Buy Credits 💰", (ctx) => {
    const buyText = `💰 *Buy Credits - Price List*\n` + `━━━━━━━━━━━━━━━━━━━━━━━━\n` + `💎 *STARTER* - 25 Credits (₹49)\n` + `🔥 *BASIC* - 100 Credits (₹149)\n` + `⭐ *PRO* - 500 Credits (₹499)\n` + `━━━━━━━━━━━━━━━━━━━━━━━━\n` + `💬 Contact admin to buy: ${SUPPORT_ADMIN}`;
    ctx.reply(buyText, { parse_mode: 'Markdown', ...getMainMenuKeyboard(ctx.from.id) });
});

bot.hears("Member Status 👥", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    const totalMembers = await usersCollection.countDocuments({});
    await ctx.reply(`📊 *Bot Member Status*\n\nTotal Members: *${totalMembers}*`, { parse_mode: 'Markdown', ...getMainMenuKeyboard(ctx.from.id) });
});

// --- ADMIN SCENE TRIGGERS ---
bot.hears("Add Credit 👤", (ctx) => ADMIN_IDS.includes(ctx.from.id) && ctx.scene.enter('add_credit_wizard'));
bot.hears("Broadcast 📢", (ctx) => ADMIN_IDS.includes(ctx.from.id) && ctx.scene.enter('broadcast_scene'));

// --- CORE NUMBER LOOKUP HANDLER ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id, number = ctx.message.text.trim();
    if (!/^\d{10,}$/.test(number)) {
        return ctx.reply("That doesn't seem to be a valid command or phone number. Please use the menu buttons or send a 10-digit number.", getMainMenuKeyboard(userId));
    }
    const userDoc = await usersCollection.findOne({ _id: userId });
    if (!userDoc) return ctx.reply("Please press /start to register.");
    if (userDoc.credits < 1) return ctx.reply("You have insufficient credits.", getMainMenuKeyboard(userId));
    
    const processingMessage = await ctx.reply('🔎 Accessing database... This will consume 1 credit.');
    
    try {
        await usersCollection.updateOne({ _id: userId }, { $inc: { credits: -1, searches: 1 } });
        const response = await axios.get(`https://numinfoapi.vercel.app/api/num?number=${number}`, { timeout: 15000 });
        await ctx.deleteMessage(processingMessage.message_id);
        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
            await ctx.reply(`✅ *Database Report Generated!*\nFound *${response.data.length}* record(s) for \`${number}\`. Details below:`, { parse_mode: 'Markdown' });
            for (const [index, record] of response.data.entries()) {
                await ctx.reply(formatRealRecordAsMessage(record, index, response.data.length), { parse_mode: 'Markdown' });
            }
        } else {
            throw new Error("No data found");
        }
    } catch (error) {
        await usersCollection.updateOne({ _id: userId }, { $inc: { credits: 1, searches: -1 } }); // Refund credit
        await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, undefined, 
            `❌ *No Data Found.*\nPlease check the number and try again. Your credit has been refunded.`
        , { parse_mode: 'Markdown' });
    } finally {
        const finalUserDoc = await usersCollection.findOne({ _id: userId });
        await ctx.reply(`💳 Credits remaining: *${finalUserDoc.credits}*`, { parse_mode: 'Markdown', ...getMainMenuKeyboard(userId) });
    }
});

// --- EXPORT FOR VERCEL ---
module.exports = async (req, res) => {
    try {
        await bot.handleUpdate(req.body, res);
    } catch (err) {
        console.error("Error handling update:", err);
    }
    if (!res.writableEnded) {
        res.status(200).send('OK');
    }
};
