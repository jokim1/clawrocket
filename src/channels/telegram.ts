import { Api, Bot, GrammyError } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { ChannelDeliveryError } from '../clawrocket/channels/channel-errors.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onInboundEvent?: ChannelOpts['onInboundEvent'];
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;
      if (ctx.from?.is_bot || ctx.from?.id === ctx.me?.id) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      const entities = ctx.message.entities || [];
      const isBotMentioned = botUsername
        ? entities.some((entity) => {
            if (entity.type !== 'mention') return false;
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          })
        : false;
      if (botUsername) {
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      const consumed = this.opts.onInboundEvent
        ? await this.opts.onInboundEvent({
            platform: 'telegram',
            target_kind: 'chat',
            target_id: chatJid,
            platform_event_id: ctx.update.update_id.toString(),
            external_message_id: msgId,
            sender_id: sender,
            sender_name: senderName,
            content,
            timestamp,
            target_display_name: chatName,
            is_mentioned: isBotMentioned,
            metadata: {
              isGroup,
              chatType: ctx.chat.type,
            },
          })
        : false;
      if (consumed) {
        logger.info(
          { chatJid, chatName, sender: senderName },
          'Telegram message routed to talk channel binding',
        );
        return;
      }

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = async (ctx: any, placeholder: string) => {
      if (ctx.from?.is_bot || ctx.from?.id === ctx.me?.id) return;
      const chatJid = `tg:${ctx.chat.id}`;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const content = `${placeholder}${caption}`;
      const chatName =
        ctx.chat.type === 'private' ? senderName : ctx.chat.title || chatJid;

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      const consumed = this.opts.onInboundEvent
        ? await this.opts.onInboundEvent({
            platform: 'telegram',
            target_kind: 'chat',
            target_id: chatJid,
            platform_event_id: ctx.update.update_id.toString(),
            external_message_id: ctx.message.message_id.toString(),
            sender_id: ctx.from?.id?.toString() || null,
            sender_name: senderName,
            content,
            timestamp,
            target_display_name: chatName,
            is_mentioned: false,
            metadata: {
              isGroup,
              chatType: ctx.chat.type,
              nonText: true,
            },
          })
        : false;
      if (consumed) return;

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => void storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => void storeNonText(ctx, '[Video]'));
    this.bot.on(
      'message:voice',
      (ctx) => void storeNonText(ctx, '[Voice message]'),
    );
    this.bot.on('message:audio', (ctx) => void storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      void storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      void storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on(
      'message:location',
      (ctx) => void storeNonText(ctx, '[Location]'),
    );
    this.bot.on(
      'message:contact',
      (ctx) => void storeNonText(ctx, '[Contact]'),
    );

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      throw new ChannelDeliveryError(
        'Telegram bot not initialized',
        'transient',
        'bot_not_initialized',
      );
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
      throw classifyTelegramError(err);
    }
  }

  async probe(): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram bot not initialized');
    }
    await this.bot.api.getMe();
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<boolean> {
  if (poolApis.length === 0) {
    logger.warn('No pool bots available for Telegram pool send');
    return false;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned pool bot');
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
    return true;
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
    return false;
  }
}

function classifyTelegramError(err: unknown): ChannelDeliveryError {
  if (err instanceof GrammyError) {
    const status = err.error_code;
    const desc = (err.description || '').toLowerCase();

    // 403 — bot kicked, blocked, or lacks permissions
    if (status === 403) {
      if (desc.includes('bot was kicked') || desc.includes('bot was blocked')) {
        return new ChannelDeliveryError(err.message, 'permanent', 'bot_kicked');
      }
      return new ChannelDeliveryError(err.message, 'permanent', 'forbidden');
    }

    // 400 — chat not found, peer invalid
    if (status === 400) {
      if (
        desc.includes('chat not found') ||
        desc.includes('peer_id_invalid')
      ) {
        return new ChannelDeliveryError(
          err.message,
          'permanent',
          'chat_not_found',
        );
      }
      return new ChannelDeliveryError(err.message, 'permanent', 'bad_request');
    }

    // 429 — rate limited
    if (status === 429) {
      return new ChannelDeliveryError(err.message, 'rate_limited', 'rate_limited');
    }

    // 5xx — transient server errors
    if (status >= 500) {
      return new ChannelDeliveryError(err.message, 'transient', 'api_error');
    }
  }

  // Network errors and everything else → transient
  const message = err instanceof Error ? err.message : 'Unknown send error';
  return new ChannelDeliveryError(message, 'transient', 'network_timeout');
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
