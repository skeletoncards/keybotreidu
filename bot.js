const {
    Client, GatewayIntentBits, EmbedBuilder,
    ButtonBuilder, ButtonStyle, ActionRowBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    Events, PermissionFlagsBits
} = require("discord.js");
const fetch = require("node-fetch");

const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "change_me";
const SERVER_URL   = process.env.SERVER_URL   || "http://localhost:3000";
const ALLOWED_ROLE = process.env.ALLOWED_ROLE; // Role ID needed to get a key
const ADMIN_ROLE   = process.env.ADMIN_ROLE;   // Role ID for admin commands
const KEY_CHANNEL  = process.env.KEY_CHANNEL;  // Channel ID for the button embed

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

// ── Helpers ───────────────────────────────────────────────────
function hasRole(member, roleId) {
    if (!roleId) return true;
    return member.roles.cache.has(roleId);
}

function isAdmin(member) {
    if (!ADMIN_ROLE) return member.permissions.has(PermissionFlagsBits.Administrator);
    return member.roles.cache.has(ADMIN_ROLE);
}

function msToHMS(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
}

async function generateKey(userId, discordId, discordTag) {
    const res = await fetch(`${SERVER_URL}/generate`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ secret: ADMIN_SECRET, userId, discordId, discordTag })
    });
    return res.json();
}

// ── Build the persistent panel embed ─────────────────────────
function buildPanel() {
    const embed = new EmbedBuilder()
        .setColor(0x7C5CBF)
        .setTitle("🔑  reidu's scripts — Key System")
        .setDescription(
            "Press **Get Key** below to receive your **24-hour script key**.\n\n" +
            "**How it works:**\n" +
            "› Click the button\n" +
            "› Enter your Roblox User ID in the popup\n" +
            "› Bot DMs you a key instantly\n" +
            "› Paste it into the script loader\n\n" +
            "**Rules:**\n" +
            "› Keys last **24 hours** then expire\n" +
            "› Each key is **tied to your Roblox account**\n" +
            "› Do **not** share your key\n\n" +
            "**Finding your Roblox ID:**\n" +
            "Go to your profile on roblox.com\n" +
            "The number in the URL is your ID:\n" +
            "`roblox.com/users/` **123456789** `/profile`"
        )
        .setFooter({ text: "reidu's scripts • one key per 24h" })
        .setTimestamp();

    const button = new ButtonBuilder()
        .setCustomId("get_key")
        .setLabel("Get Key")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("🔑");

    const row = new ActionRowBuilder().addComponents(button);
    return { embeds: [embed], components: [row] };
}

// ── Post/refresh the panel in KEY_CHANNEL ─────────────────────
async function refreshPanel(guild) {
    if (!KEY_CHANNEL) return console.warn("[Bot] KEY_CHANNEL not set.");
    const channel = await guild.channels.fetch(KEY_CHANNEL).catch(() => null);
    if (!channel) return console.warn("[Bot] KEY_CHANNEL not found.");

    const messages = await channel.messages.fetch({ limit: 20 });
    const existing = messages.find(
        m => m.author.id === client.user.id && m.embeds.length > 0
    );

    const panel = buildPanel();
    if (existing) {
        await existing.edit(panel);
        console.log("[Bot] Panel refreshed.");
    } else {
        await channel.send(panel);
        console.log("[Bot] Panel posted.");
    }
}

// ── Handle button click → show modal ─────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() || interaction.customId !== "get_key") return;

    try {
        if (!hasRole(interaction.member, ALLOWED_ROLE)) {
            return await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xDC3545)
                    .setDescription("❌ You don't have the required role to get a key.")
                ],
                ephemeral: true
            });
        }

        const modal = new ModalBuilder()
            .setCustomId("key_modal")
            .setTitle("Get Your Script Key");

        const robloxInput = new TextInputBuilder()
            .setCustomId("roblox_id")
            .setLabel("Your Roblox User ID")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. 123456789")
            .setMinLength(4)
            .setMaxLength(20)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(robloxInput));
        await interaction.showModal(modal);
    } catch (e) {
        // Interaction expired (Discord's 3s window) — log and move on, do not crash
        console.warn("[Bot] Button interaction expired before response:", e.message);
    }
});

// ── Handle modal submit ───────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId !== "key_modal") return;

    try {
        await interaction.deferReply({ ephemeral: true });
    } catch (e) {
        console.warn("[Bot] Modal interaction expired before defer:", e.message);
        return;
    }

    const robloxId = interaction.fields.getTextInputValue("roblox_id").trim();

    if (!/^\d+$/.test(robloxId)) {
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(0xDC3545)
                .setDescription(
                    "❌ That doesn't look like a valid Roblox ID.\n\n" +
                    "It should be numbers only, like `123456789`.\n" +
                    "Find it in your profile URL on roblox.com."
                )
            ]
        });
    }

    try {
        const data = await generateKey(robloxId, interaction.user.id, interaction.user.tag);

        // Already has an active key — re-DM it
        if (!data.success && data.reason === "already_active") {
            const remaining = data.expiresAt - Date.now();

            const dmEmbed = new EmbedBuilder()
                .setColor(0xFFC107)
                .setTitle("⚠️ You already have an active key")
                .setDescription(
                    `Your key expires in **${msToHMS(remaining)}**.\n\n` +
                    "**Your key:**\n" +
                    `\`\`\`\n${data.key}\n\`\`\`\n` +
                    `🔒 Roblox ID: \`${robloxId}\`\n\n` +
                    "⚠️ Do not share this key — it is tied to your account."
                )
                .setFooter({ text: "reidu's scripts" });

            const dmSent = await interaction.user.send({ embeds: [dmEmbed] }).catch(() => null);

            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(0xFFC107)
                    .setDescription(
                        dmSent
                            ? `⚠️ You already have an active key (expires in ${msToHMS(remaining)}).\nI've re-sent it to your DMs!`
                            : `⚠️ You already have an active key (expires in ${msToHMS(remaining)}).\n❌ Couldn't DM you — enable DMs from server members.`
                    )
                ]
            });
        }

        if (!data.success) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(0xDC3545)
                    .setDescription(`❌ Failed to generate key: \`${data.reason}\``)
                ]
            });
        }

        // Success — DM the key
        const expiresIn = msToHMS(data.expiresAt - Date.now());

        const dmEmbed = new EmbedBuilder()
            .setColor(0x7C5CBF)
            .setTitle("🔑 Your Script Key")
            .setDescription(
                "**Paste this into the script loader when prompted:**\n" +
                `\`\`\`\n${data.key}\n\`\`\`\n` +
                `⏰ **Expires in:** ${expiresIn}\n` +
                `🔒 **Roblox ID:** \`${robloxId}\`\n\n` +
                "⚠️ **Do not share this key — it is bound to your Roblox account.**\n" +
                "After it expires, just press **Get Key** again in the Discord."
            )
            .setTimestamp()
            .setFooter({ text: "reidu's scripts — expires in 24h" });

        const dmSent = await interaction.user.send({ embeds: [dmEmbed] }).catch(() => null);

        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(dmSent ? 0x78C87A : 0xDC3545)
                .setDescription(
                    dmSent
                        ? `✅ Key sent to your DMs!\n⏰ Expires in ${expiresIn}.`
                        : "❌ Couldn't DM you.\nPlease **enable DMs from server members** in your Privacy Settings and try again."
                )
            ]
        });

    } catch (e) {
        console.error("[Bot] Modal submit error:", e);
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(0xDC3545)
                .setDescription("❌ Server error. Please try again in a moment.")
            ]
        });
    }
});

// ── Text commands (admin only) ────────────────────────────────
client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.guild) return;

    // !refreshpanel — re-post or update the key panel
    if (msg.content === "!refreshpanel") {
        if (!isAdmin(msg.member)) return;
        await refreshPanel(msg.guild);
        msg.reply("✅ Panel refreshed!").then(m =>
            setTimeout(() => m.delete().catch(() => {}), 4000)
        );
        msg.delete().catch(() => {});
    }

    // !revokekey <RobloxUserId>
    if (msg.content.startsWith("!revokekey")) {
        if (!isAdmin(msg.member)) return;
        const userId = msg.content.split(/\s+/)[1];
        if (!userId) return msg.reply("Usage: `!revokekey <RobloxUserId>`");

        const res  = await fetch(`${SERVER_URL}/revoke`, {
            method:  "DELETE",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ secret: ADMIN_SECRET, userId })
        });
        const data = await res.json();
        msg.reply(
            data.success && data.removed > 0
                ? `✅ Revoked ${data.removed} key(s) for \`${userId}\`.`
                : `⚠️ No active keys found for \`${userId}\`.`
        );
    }

    // !listkeys
    if (msg.content === "!listkeys") {
        if (!isAdmin(msg.member)) return;
        const res  = await fetch(`${SERVER_URL}/keys?secret=${ADMIN_SECRET}`);
        const keys = await res.json();

        if (!keys.length) return msg.reply("No active keys.");

        const lines = keys.map(e => {
            const rem = Math.max(0, e.expiresAt - Date.now());
            return `\`${e.userId}\` | ${e.discordTag} | ⏳ ${msToHMS(rem)} left | verified ${e.verifyCount || 0}x`;
        });

        const embed = new EmbedBuilder()
            .setColor(0x7C5CBF)
            .setTitle("🔑 Active Keys")
            .setDescription(lines.join("\n") || "None");

        msg.reply({ embeds: [embed] });
    }
});

// ── On ready ──────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);

    for (const guild of client.guilds.cache.values()) {
        await refreshPanel(guild).catch(console.error);
    }
});

// ── Global crash guard (catches expired interactions and other async errors) ──
process.on("unhandledRejection", (err) => {
    if (err && err.code === 10062) {
        console.warn("[Bot] Interaction expired (10062) — ignoring.");
        return;
    }
    console.error("[Bot] Unhandled rejection:", err);
});

client.login(BOT_TOKEN);
