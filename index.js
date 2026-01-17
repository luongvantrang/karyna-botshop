// ===================== ATLANTIS STORE BOT (ALL-IN-ONE) =====================
// discord.js v14
// Files: index.js, config.json, orders.json (auto), invite_db.json (auto)
// ==========================================================================

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle,
  PermissionFlagsBits,
  StringSelectMenuBuilder
} = require('discord.js');

const fs = require('fs');

// ===================== CONFIG =====================
let config = require('./config.json');

const DB_FILE = './orders.json';
const INVITE_DB_FILE = './invite_db.json';
const CONFIG_FILE = './config.json';

// init files
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]', 'utf8');
if (!fs.existsSync(INVITE_DB_FILE)) {
  fs.writeFileSync(INVITE_DB_FILE, JSON.stringify({
    balances: {},      // key = guildId:userId -> { money, invites, leaves }
    pending: {},       // key = guildId:joinedUserId -> pending info
    credited: {},      // key = guildId:joinedUserId -> credit info
    inviterMap: {}     // key = guildId:joinedUserId -> inviterId (last known)
  }, null, 2), 'utf8');
}

// ===================== HELPERS =====================
function safeReadJson(path, fallback) {
  try {
    const raw = fs.readFileSync(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function safeWriteJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}
function loadOrders() { return safeReadJson(DB_FILE, []); }
function saveOrders(data) { safeWriteJson(DB_FILE, data); }

function loadInviteDB() {
  return safeReadJson(INVITE_DB_FILE, { balances: {}, pending: {}, credited: {}, inviterMap: {} });
}
function saveInviteDB(db) { safeWriteJson(INVITE_DB_FILE, db); }

function saveConfig(newConfig) {
  safeWriteJson(CONFIG_FILE, newConfig);
  config = newConfig;
}

function k(guildId, userId) { return `${guildId}:${userId}`; }
function fmtMoney(n) {
  const num = Number(n || 0);
  return num.toLocaleString('vi-VN') + 'đ';
}
function now() { return Date.now(); }

function ensureInviteConfig() {
  if (!config.invite) config.invite = {};
  if (typeof config.invite.rate !== 'number') config.invite.rate = 2000;
  if (typeof config.invite.holdHours !== 'number') config.invite.holdHours = 24;
  if (typeof config.invite.minAccountAgeDays !== 'number') config.invite.minAccountAgeDays = 7;
  if (config.invite.requireRoleId === undefined) config.invite.requireRoleId = null;
  if (config.invite.logChannelId === undefined) config.invite.logChannelId = null;

  // auto create invite by button
  if (config.invite.inviteChannelId === undefined) config.invite.inviteChannelId = null;
  if (typeof config.invite.inviteMaxAge !== 'number') config.invite.inviteMaxAge = 0;     // seconds
  if (typeof config.invite.inviteMaxUses !== 'number') config.invite.inviteMaxUses = 0;   // 0=unlimited

  // OPTIONAL: auto kick if no member role after some minutes (default OFF)
  if (config.invite.autoKickNoRole === undefined) config.invite.autoKickNoRole = false;
  if (typeof config.invite.kickAfterMinutes !== 'number') config.invite.kickAfterMinutes = 10;

  if (!config.invite.redeem) {
    config.invite.redeem = {
      enabled: false,
      currencyName: "Tiền Invite",
      orderPrefix: "REDEEM",
      statusPending: "ĐANG XỬ LÝ REDEEM",
      statusDone: "REDEEM HOÀN TẤT",
      services: []
    };
  }

  if (!config.design) config.design = {};
  if (!config.design.statusPending) config.design.statusPending = "ĐÃ THANH TOÁN (ĐANG TIẾN HÀNH)";
  if (!config.design.statusDone) config.design.statusDone = "ĐÃ HOÀN THÀNH";
}

async function sendInviteLog(guild, text) {
  try {
    const logId = config.invite?.logChannelId;
    if (!logId) return;
    const ch = await guild.channels.fetch(logId).catch(() => null);
    if (!ch || !ch.isTextBased()) return;
    await ch.send({ content: text });
  } catch { }
}

// ===================== DASHBOARD UI =====================
function buildDashboardEmbed() {
  return new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle('ATLANTIS • INVITE DASHBOARD')
    .setDescription(
      '━━━━━━━━━━━━━━━━━━━━━━\n' +
      'Quản lý thưởng invite & redeem\n' +
      'Cộng/trừ theo join/out • Chống acc ảo\n' +
      '━━━━━━━━━━━━━━━━━━━━━━'
    )
    .addFields(
      { name: 'SỐ DƯ', value: 'Xem tiền invite + rate', inline: true },
      { name: 'THƯỞNG', value: 'Xem pending/credited', inline: true },
      { name: 'INVITE', value: 'Xem / Tạo link mới', inline: true },
      { name: 'TOP', value: 'Bảng xếp hạng', inline: true },
      { name: 'REDEEM', value: 'Đổi gói', inline: true }
    )
    .setFooter({ text: 'ATLANTIS • Dashboard' });
}

function buildDashboardButtons() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash_balance').setLabel('Số Dư').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('dash_reward').setLabel('Thưởng').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('dash_myinvite').setLabel('Invite của bạn').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash_make_invite').setLabel('Tạo Invite').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash_top').setLabel('Top').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash_redeem').setLabel('Redeem').setStyle(ButtonStyle.Primary),
  );

  return [row1, row2];
}

async function fetchUserInvites(guild, userId) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return [];
  return invites.filter(i => i.inviter?.id === userId);
}

function getUserPendingAndCredited(db, guildId, inviterId) {
  const pending = [];
  const credited = [];
  for (const p of Object.values(db.pending || {})) {
    if (p?.guildId === guildId && p?.inviterId === inviterId) pending.push(p);
  }
  for (const c of Object.values(db.credited || {})) {
    if (c?.guildId === guildId && c?.inviterId === inviterId) credited.push(c);
  }
  return { pending, credited };
}

async function replyBalance(interaction) {
  ensureInviteConfig();
  const db = loadInviteDB();
  const bKey = k(interaction.guildId, interaction.user.id);
  const bal = db.balances[bKey] || { money: 0, invites: 0, leaves: 0 };

  return interaction.reply({
    ephemeral: true,
    content:
      `Số dư: **${fmtMoney(bal.money)}**\n` +
      `Invite hợp lệ: **${bal.invites}**\n` +
      `Out bị trừ: **${bal.leaves}**\n` +
      `Rate: **${fmtMoney(config.invite.rate)} / 1 invite**`
  });
}

async function replyReward(interaction) {
  ensureInviteConfig();
  const db = loadInviteDB();
  const { pending, credited } = getUserPendingAndCredited(db, interaction.guildId, interaction.user.id);

  const hold = config.invite.holdHours || 0;
  const minAge = config.invite.minAccountAgeDays || 0;

  const sample = pending.slice(0, 8).map(p => {
    const leftMs = Math.max(0, p.eligibleAt - Date.now());
    const leftH = Math.ceil(leftMs / 3600000);
    return `• <@${p.joinedUserId}> (còn ~${leftH}h)`;
  }).join('\n') || '—';

  return interaction.reply({
    ephemeral: true,
    content:
      `Thưởng invite:\n` +
      `• Rate: **${fmtMoney(config.invite.rate)} / 1**\n` +
      `• Hold: **${hold}h**\n` +
      `• Min account age: **${minAge} ngày**\n\n` +
      `Pending: **${pending.length}**\n${sample}\n\n` +
      `Credited: **${credited.length}**`
  });
}

async function replyMyInvite(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ ephemeral: true, content: 'Lỗi guild.' });

  const userInvites = await fetchUserInvites(guild, interaction.user.id);
  if (!userInvites.length) {
    return interaction.reply({
      ephemeral: true,
      content:
        'Bạn chưa có invite link riêng (bot không thấy invite do bạn tạo).\n' +
        'Bạn hãy tự tạo invite trong 1 kênh mà bạn có quyền **Create Invite** rồi thử lại.\n\n' +
        'Lưu ý: bot cần quyền **Manage Server** để đọc invites.'
    });
  }

  const best = userInvites.sort((a, b) => (b.uses || 0) - (a.uses || 0))[0];
  return interaction.reply({
    ephemeral: true,
    content:
      `Invite của bạn:\n` +
      `• Link: ${best.url}\n` +
      `• Uses: **${best.uses || 0}**\n` +
      `• Kênh: <#${best.channelId}>`
  });
}

async function replyMakeInvite(interaction) {
  ensureInviteConfig();

  const guild = interaction.guild;
  if (!guild) return interaction.reply({ ephemeral: true, content: 'Lỗi guild.' });

  const channelId = config.invite.inviteChannelId || interaction.channelId;
  const ch = await guild.channels.fetch(channelId).catch(() => null);

  if (!ch || !ch.isTextBased()) {
    return interaction.reply({
      ephemeral: true,
      content: 'Không tìm thấy kênh để tạo invite. Set `invite.inviteChannelId` trong config.json.'
    });
  }

  const maxAge = Number(config.invite.inviteMaxAge || 0);
  const maxUses = Number(config.invite.inviteMaxUses || 0);

  try {
    const invite = await ch.createInvite({
      maxAge,
      maxUses,
      unique: true,
      reason: `Dashboard invite by ${interaction.user.tag}`
    });

    return interaction.reply({
      ephemeral: true,
      content:
        `Invite mới:\n` +
        `• Link: ${invite.url}\n` +
        `• Kênh: <#${ch.id}>\n` +
        `• Hết hạn: **${maxAge === 0 ? 'Không' : `${Math.floor(maxAge / 60)} phút`}**\n` +
        `• Giới hạn dùng: **${maxUses === 0 ? 'Không' : maxUses}**`
    });
  } catch {
    return interaction.reply({
      ephemeral: true,
      content: 'Không tạo được invite. Bot cần quyền **Create Invite** (và kênh phải cho phép).'
    });
  }
}

async function replyTop(interaction) {
  ensureInviteConfig();
  const db = loadInviteDB();

  const rows = [];
  for (const [key, val] of Object.entries(db.balances || {})) {
    const [gId, uId] = key.split(':');
    if (gId !== interaction.guildId) continue;
    rows.push({ userId: uId, money: val.money || 0, invites: val.invites || 0, leaves: val.leaves || 0 });
  }

  rows.sort((a, b) => (b.money - a.money) || (b.invites - a.invites));
  const top = rows.slice(0, 10);
  if (!top.length) return interaction.reply({ ephemeral: true, content: 'Chưa có dữ liệu top.' });

  const lines = top.map((r, i) =>
    `#${i + 1} <@${r.userId}> — ${fmtMoney(r.money)} | invites: ${r.invites} | out: ${r.leaves}`
  ).join('\n');

  const embed = new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle('TOP INVITE (theo tiền)')
    .setDescription(lines);

  return interaction.reply({ ephemeral: true, embeds: [embed] });
}

// ===================== DISCORD CLIENT =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,        // invite/anti-fake
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ===================== INVITES CACHE =====================
const invitesCache = new Map(); // guildId -> Map(code -> uses)

async function refreshInvitesForGuild(guild) {
  try {
    const invites = await guild.invites.fetch();
    const m = new Map();
    invites.forEach(inv => m.set(inv.code, inv.uses || 0));
    invitesCache.set(guild.id, m);
  } catch { }
}

async function resolveInviter(guild) {
  try {
    const before = invitesCache.get(guild.id) || new Map();
    const invites = await guild.invites.fetch();

    const after = new Map();
    invites.forEach(inv => after.set(inv.code, inv.uses || 0));
    invitesCache.set(guild.id, after);

    let usedInvite = null;
    for (const [code, uses] of after.entries()) {
      const prev = before.get(code) || 0;
      if (uses > prev) {
        usedInvite = invites.find(i => i.code === code) || null;
        break;
      }
    }

    if (!usedInvite) return { inviterId: null, code: null };
    return { inviterId: usedInvite.inviter?.id || null, code: usedInvite.code };
  } catch {
    return { inviterId: null, code: null };
  }
}

// ===================== COMMANDS =====================
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Cấu hình hệ thống')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName('kenh_quan_ly').setDescription('Kênh Admin nhận đơn').setRequired(true))
    .addChannelOption(o => o.setName('kenh_legit').setDescription('Kênh để Bot đăng bài Legit').setRequired(true)),

  new SlashCommandBuilder()
    .setName('bill')
    .setDescription('Tạo bill order')
    .addUserOption(o => o.setName('khachhang').setDescription('Khách hàng').setRequired(true))
    .addStringOption(o => o.setName('sanpham').setDescription('Tên sản phẩm').setRequired(true))
    .addStringOption(o => o.setName('gia').setDescription('Giá đơn hàng').setRequired(true))
    .addAttachmentOption(o => o.setName('anh_bill').setDescription('Ảnh bill (không upload lại, chỉ lưu link)').setRequired(false))
    .addChannelOption(o => o.setName('kenh').setDescription('Chọn kênh trả bill').setRequired(false)),

  new SlashCommandBuilder().setName('dashboard').setDescription('Gửi Dashboard Atlantis (nút bấm)'),
  new SlashCommandBuilder().setName('balance').setDescription('Xem số dư Tiền Invite'),
  new SlashCommandBuilder().setName('reward').setDescription('Xem thưởng invite: pending/credited'),
  new SlashCommandBuilder().setName('top').setDescription('Top người mời nhiều nhất (theo tiền)'),
  new SlashCommandBuilder().setName('myinvite').setDescription('Xem invite link & số lượt mời của bạn'),

  new SlashCommandBuilder()
    .setName('invcheck')
    .setDescription('Check ai đã mời 1 member (theo dữ liệu bot)')
    .addUserOption(o => o.setName('member').setDescription('Member cần check').setRequired(true)),

  new SlashCommandBuilder()
    .setName('redeem')
    .setDescription('Đổi thưởng bằng tiền invite (dropdown)'),
];

const rest = new REST({ version: '10' }).setToken(config.bot.token);

// ===================== READY =====================
client.on('ready', async () => {
  console.log(`✅ Bot Online: ${client.user.tag}`);
  ensureInviteConfig();

  // register commands
  try {
    await rest.put(
      Routes.applicationGuildCommands(config.bot.clientId, config.bot.guildId),
      { body: commands }
    );
  } catch (e) {
    console.error('Register commands error:', e);
  }

  // init invite cache
  try {
    const g = await client.guilds.fetch(config.bot.guildId).catch(() => null);
    if (g) await refreshInvitesForGuild(g);
  } catch { }

  // pending processor
  setInterval(async () => {
    try {
      ensureInviteConfig();
      const db = loadInviteDB();
      const keys = Object.keys(db.pending || {});
      if (!keys.length) return;

      for (const pKey of keys) {
        const p = db.pending[pKey];
        if (!p) continue;

        const guild = client.guilds.cache.get(p.guildId);
        if (!guild) continue;

        if (now() < p.eligibleAt) continue;

        const member = await guild.members.fetch(p.joinedUserId).catch(() => null);
        if (!member) {
          delete db.pending[pKey];
          continue;
        }

        // min age
        const minDays = config.invite.minAccountAgeDays || 0;
        const ageMs = now() - member.user.createdTimestamp;
        const minMs = minDays * 24 * 3600 * 1000;
        if (ageMs < minMs) {
          // log 1 lần thôi
          if (!p.notifiedTooNew) {
            await sendInviteLog(guild, `Không cộng (acc quá mới): <@${p.joinedUserId}>`);
            p.notifiedTooNew = true;
            // vẫn giữ pending để user có thể ở lại đủ ngày tuổi account (nếu muốn)
            // hoặc bạn có thể delete luôn pending ở đây
          }
          // quyết định: xoá pending để đỡ spam & không bao giờ cộng cho acc mới
          delete db.pending[pKey];
          saveInviteDB(db);
          continue;
        }

        // require role (optional)
        const roleId = config.invite.requireRoleId;
        if (roleId && !member.roles.cache.has(roleId)) {
          if (config.invite.autoKickNoRole) {
            try {
              const kickAfterMs = (config.invite.kickAfterMinutes || 10) * 60 * 1000;
              if ((now() - p.joinedAt) >= kickAfterMs) {
                await member.kick('Không có role member/verify sau thời gian quy định');
                await sendInviteLog(guild, `Kick: <@${p.joinedUserId}> (không có role member/verify)`);
                delete db.pending[pKey];
                saveInviteDB(db);
                continue;
              }
            } catch { }
          }

          // không kick -> gia hạn để chờ verify
          p.eligibleAt = now() + 24 * 3600 * 1000;
          db.pending[pKey] = p;
          saveInviteDB(db);
          continue;
        }

        // inviter valid?
        if (!p.inviterId || p.inviterId === p.joinedUserId) {
          delete db.pending[pKey];
          saveInviteDB(db);
          continue;
        }

        // credit
        const rate = config.invite.rate || 0;
        const bKey = k(p.guildId, p.inviterId);
        const bal = db.balances[bKey] || { money: 0, invites: 0, leaves: 0 };

        bal.money += rate;
        bal.invites += 1;
        db.balances[bKey] = bal;

        db.credited[pKey] = {
          guildId: p.guildId,
          joinedUserId: p.joinedUserId,
          inviterId: p.inviterId,
          creditedAt: now(),
          rate
        };

        delete db.pending[pKey];
        db.inviterMap[pKey] = p.inviterId;
        saveInviteDB(db);

        await sendInviteLog(guild, `Cộng ${fmtMoney(rate)} cho <@${p.inviterId}> (mời <@${p.joinedUserId}>)`);
      }
    } catch { }
  }, 30 * 1000);
});

// ===================== INVITE EVENTS =====================
client.on('guildMemberAdd', async (member) => {
  try {
    if (!member.guild) return;
    if (member.guild.id !== config.bot.guildId) return;

    ensureInviteConfig();
    const guild = member.guild;

    const { inviterId, code } = await resolveInviter(guild);

    const db = loadInviteDB();
    const pKey = k(guild.id, member.id);

    const holdHours = config.invite.holdHours || 0;
    const eligibleAt = now() + holdHours * 3600 * 1000;

    db.pending[pKey] = {
      guildId: guild.id,
      joinedUserId: member.id,
      inviterId,
      inviteCode: code,
      joinedAt: now(),
      eligibleAt
    };

    if (inviterId) db.inviterMap[pKey] = inviterId;
    saveInviteDB(db);

    if (inviterId) {
      await sendInviteLog(guild, `Join: <@${member.id}> | inviter: <@${inviterId}> | hold: ${holdHours}h`);
    } else {
      await sendInviteLog(guild, `Join: <@${member.id}> | inviter: (không xác định - thiếu quyền invites?)`);
    }

  } catch { }
});

client.on('guildMemberRemove', async (member) => {
  try {
    if (!member.guild) return;
    if (member.guild.id !== config.bot.guildId) return;

    ensureInviteConfig();
    const guild = member.guild;
    const db = loadInviteDB();
    const pKey = k(guild.id, member.id);

    // pending out => hủy
    if (db.pending[pKey]) {
      const p = db.pending[pKey];
      delete db.pending[pKey];
      saveInviteDB(db);

      if (p?.inviterId) {
        await sendInviteLog(guild, `Out (pending hủy): <@${member.id}> | inviter: <@${p.inviterId}>`);
      } else {
        await sendInviteLog(guild, `Out (pending hủy): <@${member.id}>`);
      }
      return;
    }

    // credited out => trừ
    const c = db.credited[pKey];
    if (c && c.inviterId) {
      const rate = c.rate || (config.invite.rate || 0);
      const bKey = k(guild.id, c.inviterId);
      const bal = db.balances[bKey] || { money: 0, invites: 0, leaves: 0 };

      bal.money -= rate;
      bal.leaves += 1;
      db.balances[bKey] = bal;

      delete db.credited[pKey];
      saveInviteDB(db);

      await sendInviteLog(guild, `Trừ ${fmtMoney(rate)} của <@${c.inviterId}> vì <@${member.id}> out (đã tính)`);
    } else {
      await sendInviteLog(guild, `Out: <@${member.id}>`);
    }
  } catch { }
});

// ===================== INTERACTIONS =====================
client.on('interactionCreate', async (interaction) => {

  // SLASH COMMANDS
  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === 'dashboard') {
      const embed = buildDashboardEmbed();
      const rows = buildDashboardButtons();
      return interaction.reply({ embeds: [embed], components: rows });
    }

    if (interaction.commandName === 'setup') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Không có quyền Admin!', ephemeral: true });
      }

      const manageChannel = interaction.options.getChannel('kenh_quan_ly');
      const legitChannel = interaction.options.getChannel('kenh_legit');

      if (!manageChannel.isTextBased() || !legitChannel.isTextBased()) {
        return interaction.reply({ content: 'Các kênh phải là kênh chat text!', ephemeral: true });
      }

      config.bot.manageChannelId = manageChannel.id;
      config.bot.legitChannelId = legitChannel.id;
      saveConfig(config);

      return interaction.reply({
        content: `Setup thành công!\n- Quản lý đơn: ${manageChannel}\n- Legit: ${legitChannel}`
      });
    }

    if (interaction.commandName === 'myinvite') return replyMyInvite(interaction);
    if (interaction.commandName === 'reward') return replyReward(interaction);

    if (interaction.commandName === 'invcheck') {
      const member = interaction.options.getUser('member');
      const db = loadInviteDB();
      const pKey = k(interaction.guildId, member.id);

      const p = db.pending?.[pKey];
      const c = db.credited?.[pKey];
      const inv = db.inviterMap?.[pKey] || null;

      const inviterId = p?.inviterId || c?.inviterId || inv;

      if (!inviterId) {
        return interaction.reply({ ephemeral: true, content: `Không có dữ liệu inviter cho <@${member.id}>.` });
      }

      let state = 'HISTORY';
      if (p) state = 'PENDING';
      else if (c) state = 'CREDITED';

      return interaction.reply({
        ephemeral: true,
        content:
          `Member: <@${member.id}>\n` +
          `Inviter: <@${inviterId}>\n` +
          `Trạng thái: **${state}**`
      });
    }

    // ✅ BILL (NO FILE FETCH) — chỉ lưu URL ảnh
    if (interaction.commandName === 'bill') {
      await interaction.deferReply({ ephemeral: true });

      const manageId = config.bot.manageChannelId;
      if (!manageId) return interaction.editReply({ content: 'Chưa setup! Dùng /setup trước.' });

      const manageChannel = interaction.guild.channels.cache.get(manageId);
      if (!manageChannel) return interaction.editReply({ content: 'Lỗi kênh quản lý.' });

      const customer = interaction.options.getUser('khachhang');
      const product = interaction.options.getString('sanpham');
      const price = interaction.options.getString('gia');
      const attachment = interaction.options.getAttachment('anh_bill');
      const targetChannel = interaction.options.getChannel('kenh') || interaction.channel;

      const billUrl = attachment?.url || null;

      const createContent = (statusText) =>
        `>>> **Khách hàng:** ${customer}\n` +
        `**Đã order:** **${product}**\n` +
        `**Giá:** \`${price}\`\n` +
        `**Trạng thái:** \`${statusText}\`` +
        (billUrl ? `\n**Ảnh bill:** ${billUrl}` : '');

      try {
        const publicMsg = await targetChannel.send({
          content: createContent(config.design.statusPending)
        });

        const adminEmbed = new EmbedBuilder()
          .setColor('#2b2d31')
          .setTitle('Đơn hàng mới')
          .addFields(
            { name: 'Khách', value: `${customer.tag}`, inline: true },
            { name: 'Hàng', value: product, inline: true },
            { name: 'Giá', value: price, inline: true },
            { name: 'Kênh', value: `${targetChannel}`, inline: true },
            { name: 'Link', value: `[Xem](${publicMsg.url})`, inline: false },
            { name: 'Ảnh bill', value: billUrl ? billUrl : '—', inline: false }
          )
          .setTimestamp()
          .setFooter({ text: `Ticket: #${targetChannel.name}` });

        const btnRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('btn_complete')
            .setLabel('Xác nhận xong')
            .setStyle(ButtonStyle.Success)
        );

        const manageMsg = await manageChannel.send({ embeds: [adminEmbed], components: [btnRow] });

        const orders = loadOrders();
        orders.push({
          type: "bill",
          manageMsgId: manageMsg.id,
          publicMsgId: publicMsg.id,
          publicChannelId: targetChannel.id,
          customer: customer.id,
          product,
          price,
          billUrl,
          serverId: interaction.guild.id
        });
        saveOrders(orders);

        return interaction.editReply({ content: `✅ Lên đơn thành công!` });
      } catch (e) {
        console.error(e);
        return interaction.editReply({ content: 'Lỗi gửi tin nhắn/thiếu quyền.' });
      }
    }

    if (interaction.commandName === 'balance') return replyBalance(interaction);
    if (interaction.commandName === 'top') return replyTop(interaction);

    // REDEEM
    if (interaction.commandName === 'redeem') {
      ensureInviteConfig();

      if (!config.invite?.redeem?.enabled) {
        return interaction.reply({ ephemeral: true, content: 'Redeem đang tắt.' });
      }

      const services = config.invite.redeem.services || [];
      if (!services.length) {
        return interaction.reply({ ephemeral: true, content: 'Chưa cấu hình gói redeem.' });
      }

      const options = services.map(s => ({
        label: s.name,
        description: `${fmtMoney(s.cost)} - ${s.details || 'Không có mô tả'}`.slice(0, 100),
        value: s.id
      }));

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('redeem_select')
          .setPlaceholder('Chọn gói muốn đổi')
          .addOptions(options)
      );

      return interaction.reply({
        ephemeral: true,
        content: 'Chọn gói bạn muốn redeem:',
        components: [row]
      });
    }
  }

  // DROPDOWN
  else if (interaction.isStringSelectMenu()) {
    if (interaction.customId !== 'redeem_select') return;

    ensureInviteConfig();

    const packId = interaction.values[0];
    const services = config.invite.redeem.services || [];
    const svc = services.find(s => s.id === packId);

    if (!svc) return interaction.update({ content: 'Gói không tồn tại.', components: [] });

    const db = loadInviteDB();
    const bKey = k(interaction.guildId, interaction.user.id);
    const bal = db.balances[bKey] || { money: 0, invites: 0, leaves: 0 };

    if (bal.money < svc.cost) {
      return interaction.update({
        content:
          `Bạn không đủ ${config.invite.redeem.currencyName}.\n` +
          `Hiện có: ${fmtMoney(bal.money)}\n` +
          `Cần: ${fmtMoney(svc.cost)}`,
        components: []
      });
    }

    // trừ tiền
    bal.money -= svc.cost;
    db.balances[bKey] = bal;
    saveInviteDB(db);

    const manageId = config.bot.manageChannelId;
    if (!manageId) return interaction.update({ content: 'Chưa setup kênh quản lý.', components: [] });

    const manageChannel = interaction.guild.channels.cache.get(manageId);
    if (!manageChannel) return interaction.update({ content: 'Không tìm thấy kênh quản lý.', components: [] });

    const orderNo = `${config.invite.redeem.orderPrefix}-${Date.now().toString().slice(-6)}`;
    const statusText = config.invite.redeem.statusPending || 'ĐANG XỬ LÝ REDEEM';

    const adminEmbed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle('Redeem mới')
      .addFields(
        { name: 'Khách', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: false },
        { name: 'Mã đơn', value: `\`${orderNo}\``, inline: true },
        { name: 'Gói', value: `**${svc.name}**`, inline: true },
        { name: 'Quy đổi', value: `${fmtMoney(svc.cost)} (${config.invite.redeem.currencyName})`, inline: true },
        { name: 'Chi tiết', value: svc.details ? `\`${svc.details}\`` : '—', inline: false },
        { name: 'Trạng thái', value: `\`${statusText}\``, inline: false }
      )
      .setTimestamp();

    const btnRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`btn_redeem_done_${orderNo}`)
        .setLabel('Hoàn tất Redeem')
        .setStyle(ButtonStyle.Success)
    );

    const manageMsg = await manageChannel.send({ embeds: [adminEmbed], components: [btnRow] });

    const orders = loadOrders();
    orders.push({
      type: "redeem",
      orderNo,
      manageMsgId: manageMsg.id,
      customer: interaction.user.id,
      product: svc.name,
      price: `${fmtMoney(svc.cost)} (${config.invite.redeem.currencyName})`,
      serverId: interaction.guildId,
      status: "pending"
    });
    saveOrders(orders);

    return interaction.update({
      content:
        `Redeem thành công!\n` +
        `• Gói: ${svc.name}\n` +
        `• Trừ: ${fmtMoney(svc.cost)}\n` +
        `• Số dư còn: ${fmtMoney(bal.money)}\n` +
        `• Mã đơn: ${orderNo}`,
      components: []
    });
  }

  // BUTTONS
  else if (interaction.isButton()) {
    if (interaction.customId === 'dash_balance') return replyBalance(interaction);
    if (interaction.customId === 'dash_reward') return replyReward(interaction);
    if (interaction.customId === 'dash_myinvite') return replyMyInvite(interaction);
    if (interaction.customId === 'dash_make_invite') return replyMakeInvite(interaction);
    if (interaction.customId === 'dash_top') return replyTop(interaction);

    if (interaction.customId === 'dash_redeem') {
      ensureInviteConfig();

      if (!config.invite?.redeem?.enabled) {
        return interaction.reply({ ephemeral: true, content: 'Redeem đang tắt.' });
      }

      const services = config.invite.redeem.services || [];
      if (!services.length) {
        return interaction.reply({ ephemeral: true, content: 'Chưa cấu hình gói redeem.' });
      }

      const options = services.map(s => ({
        label: s.name,
        description: `${fmtMoney(s.cost)} - ${s.details || 'Không có mô tả'}`.slice(0, 100),
        value: s.id
      }));

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('redeem_select')
          .setPlaceholder('Chọn gói muốn đổi')
          .addOptions(options)
      );

      return interaction.reply({ ephemeral: true, content: 'Chọn gói bạn muốn redeem:', components: [row] });
    }

    // ADMIN COMPLETE REDEEM
    if (interaction.customId.startsWith('btn_redeem_done_')) {
      await interaction.deferUpdate();

      const orderNo = interaction.customId.replace('btn_redeem_done_', '');
      const orders = loadOrders();
      const order = orders.find(o => o.type === 'redeem' && o.orderNo === orderNo);
      if (!order) return;

      const doneText = config.invite?.redeem?.statusDone || 'REDEEM HOÀN TẤT';

      const old = interaction.message.embeds?.[0];
      if (old) {
        const embed = EmbedBuilder.from(old);

        const fields = embed.data.fields || [];
        const newFields = fields.map(f => (
          f.name === 'Trạng thái'
            ? { name: 'Trạng thái', value: `\`${doneText}\``, inline: false }
            : f
        ));

        embed.setColor('#2ecc71').setTitle('Redeem hoàn tất').setFields(newFields);

        const disabledRow = new ActionRowBuilder().addComponents(
          ButtonBuilder.from(interaction.message.components[0].components[0])
            .setDisabled(true)
            .setLabel('Đã hoàn tất')
        );

        await interaction.editReply({ embeds: [embed], components: [disabledRow] });
      }

      order.status = "done";
      saveOrders(orders);

      try {
        const user = await client.users.fetch(order.customer);
        await user.send(`✅ Redeem đã hoàn tất.\n• Mã đơn: ${orderNo}\n• Gói: ${order.product}`);
      } catch { }

      return;
    }

    // ADMIN COMPLETE BILL
    if (interaction.customId === 'btn_complete') {
      await interaction.deferUpdate();

      const orders = loadOrders();
      const order = orders.find(o => o.manageMsgId === interaction.message.id);
      if (!order) return;

      try {
        // update bill khách
        if (order.publicChannelId && order.publicMsgId) {
          const publicChannel = await client.channels.fetch(order.publicChannelId).catch(() => null);
          if (publicChannel) {
            const publicMsg = await publicChannel.messages.fetch(order.publicMsgId).catch(() => null);
            if (publicMsg) {
              const newContent =
                `>>> **Khách hàng:** <@${order.customer}>\n` +
                `**Đã order:** **${order.product || 'Unknown'}**\n` +
                `**Giá:** \`${order.price || 'Unknown'}\`\n` +
                `**Trạng thái:** \`${config.design.statusDone}\`` +
                (order.billUrl ? `\n**Ảnh bill:** ${order.billUrl}` : '');
              await publicMsg.edit({ content: newContent });
            }
          }
        }

        // update admin panel
        const adminEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor('#2ecc71')
          .setTitle('✅ Đơn hàng hoàn tất');

        const disabledRow = new ActionRowBuilder().addComponents(
          ButtonBuilder.from(interaction.message.components[0].components[0])
            .setDisabled(true)
            .setLabel('Đã xong')
        );

        await interaction.editReply({ embeds: [adminEmbed], components: [disabledRow] });
      } catch (err) {
        console.error(err);
      }
      return;
    }
  }
});

// ===================== LOGIN =====================
ensureInviteConfig();
client.login(config.bot.token);
