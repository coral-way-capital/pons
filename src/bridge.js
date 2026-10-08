import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Routes } from 'discord.js';
import { snowflake } from './config.js';

const digest = value => createHash('sha256').update(value).digest();

export function createBridge(client, channelIds, token) {
  if (!Array.isArray(channelIds)) channelIds = [channelIds];
  if (!channelIds.length || channelIds.some(id => typeof id !== 'string' || !snowflake.test(id)) || typeof token !== 'string' || token.length < 32) {
    throw new Error('Valid channel IDs and a bridge token of at least 32 characters are required.');
  }
  const allowedChannels = new Set(channelIds);
  const defaultChannelId = channelIds[0];
  const tokenHash = digest(`Bearer ${token}`);
  const session = randomUUID();
  let sequence = 0;
  const events = [];
  const pendingChannels = new Map();

  function message(data) {
    return {
      id: data.id,
      channel_id: data.channel_id,
      author: data.author && {
        id: data.author.id, username: data.author.username, bot: !!data.author.bot,
      },
      content: data.content ?? null,
      partial: !Object.hasOwn(data, 'content'),
      is_self: data.author ? data.author.id === client.user?.id : null,
      created_at: data.timestamp ?? null,
      edited_at: data.edited_timestamp ?? null,
      attachments: data.attachments ?? [],
      embeds: data.embeds ?? [],
      reply_to: data.message_reference?.message_id ?? null,
      url: data.guild_id ? `https://discord.com/channels/${data.guild_id}/${data.channel_id}/${data.id}` : null,
    };
  }

  function publish(type, data) {
    const cursor = `${session}:${++sequence}`;
    events.push({ cursor, type, channel_id: data.channel_id, ...(data.parent_channel_id ? { parent_channel_id: data.parent_channel_id } : {}), data });
    // ponytail: bounded in-memory feed; use history to recover, add a durable queue if required.
    if (events.length > 1000) events.shift();
  }

  client.on('raw', async packet => {
    if (!['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_DELETE_BULK'].includes(packet.t) ||
        !snowflake.test(packet.d?.channel_id ?? '')) return;
    const channelId = packet.d.channel_id;
    let parentId;
    if (!allowedChannels.has(channelId)) {
      try {
        let thread = client.channels.cache.get(channelId);
        // Share uncached lookups so simultaneous thread updates retain arrival order.
        if (!thread || pendingChannels.has(channelId)) {
          let pending = pendingChannels.get(channelId);
          if (!pending) {
            pending = client.rest.get(Routes.channel(channelId)).finally(() => pendingChannels.delete(channelId));
            pendingChannels.set(channelId, pending);
          }
          thread = await pending;
        }
        parentId = thread.parentId ?? thread.parent_id;
        if (![10, 11, 12].includes(thread.type) || !allowedChannels.has(parentId)) return;
      } catch {
        return; // Unknown or inaccessible channels never enter the feed.
      }
    }
    const metadata = { channel_id: channelId, ...(parentId ? { parent_channel_id: parentId } : {}) };
    if (['MESSAGE_CREATE', 'MESSAGE_UPDATE'].includes(packet.t)) {
      publish(packet.t, { ...message(packet.d), ...metadata });
    } else if (packet.t === 'MESSAGE_DELETE') {
      publish(packet.t, { id: packet.d.id, ...metadata });
    } else if (packet.t === 'MESSAGE_DELETE_BULK') {
      publish(packet.t, { ids: packet.d.ids, ...metadata });
    }
  });
  client.on('shardDisconnect', () => publish('CONNECTION_GAP', { channel_id: null, recover_with: 'GET /messages?after=<last-message-id>' }));

  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''), tokenHash)) {
        return reply(401, { error: 'Unauthorized' });
      }
      // No browser access: protects against cross-origin and DNS-rebinding requests.
      if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) {
        return reply(403, { error: 'Only local, non-browser clients are allowed' });
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        return reply(client.isReady() ? 200 : 503, {
          ready: client.isReady(), bot_id: client.user?.id ?? null,
          channel_id: defaultChannelId, channel_ids: [...allowedChannels], cursor: `${session}:${sequence}`,
        });
      }
      if (!client.isReady()) return reply(503, { error: 'Discord is not connected' });
      if (req.method === 'GET' && url.pathname === '/events') {
        const cursor = url.searchParams.get('cursor');
        const match = cursor?.match(/^([a-f0-9-]+):(\d+)$/);
        const after = match ? Number(match[2]) : 0;
        if (cursor && (!match || match[1] !== session || !Number.isSafeInteger(after) || after > sequence || after < sequence - events.length)) {
          return reply(409, { error: 'Event cursor expired or invalid; recover from Discord history', cursor: `${session}:${sequence}` });
        }
        return reply(200, { events: events.filter(event => Number(event.cursor.split(':')[1]) > after), cursor: `${session}:${sequence}`, truncated: !cursor && sequence > events.length });
      }
      let channelId = defaultChannelId;
      let path = url.pathname;
      const channelPath = path.match(/^\/channels\/([^/]+)(\/.*)$/);
      if (channelPath) {
        if (!snowflake.test(channelPath[1])) return reply(404, { error: 'Not found' });
        if (!allowedChannels.has(channelPath[1])) return reply(403, { error: 'Access denied' });
        channelId = channelPath[1];
        path = channelPath[2];
      }
      const threadPath = path.match(/^\/threads\/([^/]+)\/messages(?:\/([^/]+))?$/);
      const single = path.match(/^\/messages\/([^/]+)$/);
      if ((threadPath && threadPath.slice(1).some(id => id !== undefined && !snowflake.test(id))) ||
          (single && !snowflake.test(single[1]))) return reply(404, { error: 'Not found' });
      if (req.method === 'GET' && path === '/threads') {
        const state = url.searchParams.get('state') ?? 'active';
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const before = url.searchParams.get('before');
        const validDate = before && /^\d{4}-\d{2}-\d{2}T/.test(before) && Number.isFinite(Date.parse(before));
        if (!['active', 'archived_public', 'archived_private'].includes(state) ||
            !Number.isInteger(limit) || limit < 1 || limit > 100 ||
            (before !== null && (state === 'active' || (state === 'archived_private' ? !snowflake.test(before) : !validDate)))) {
          return reply(400, { error: 'Use state active, archived_public, or archived_private; limit 1–100; public before is an ISO timestamp, private before is a thread ID' });
        }
        let data;
        if (state === 'active') {
          const parent = await client.rest.get(Routes.channel(channelId));
          data = await client.rest.get(Routes.guildActiveThreads(parent.guild_id));
        } else {
          const query = new URLSearchParams({ limit: String(limit) });
          if (before) query.set('before', before);
          const route = state === 'archived_public' ? Routes.channelThreads(channelId, 'public') : Routes.channelJoinedArchivedThreads(channelId);
          data = await client.rest.get(route, { query });
        }
        const threads = data.threads.filter(thread => thread.parent_id === channelId && [10, 11, 12].includes(thread.type));
        const last = data.threads.at(-1);
        return reply(200, {
          threads: threads.map(thread => ({ id: thread.id, parent_id: thread.parent_id, name: thread.name, type: thread.type, archived: !!thread.thread_metadata?.archived, locked: !!thread.thread_metadata?.locked, archive_timestamp: thread.thread_metadata?.archive_timestamp ?? null })),
          has_more: !!data.has_more,
          next_before: data.has_more && last ? (state === 'archived_private' ? last.id : last.thread_metadata?.archive_timestamp ?? null) : null,
        });
      }
      let readChannel = channelId;
      if (req.method === 'GET' && threadPath) {
        // Recheck on every read: thread membership/access can change independently.
        const thread = await client.rest.get(Routes.channel(threadPath[1]));
        if (!allowedChannels.has(thread.parent_id) || thread.parent_id !== channelId || ![10, 11, 12].includes(thread.type)) {
          return reply(403, { error: 'Access denied' });
        }
        readChannel = thread.id;
      }
      if (req.method === 'GET' && (path === '/messages' || (threadPath && !threadPath[2]))) {
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const before = url.searchParams.get('before');
        const after = url.searchParams.get('after');
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (before && after) || [before, after].some(id => id !== null && !snowflake.test(id))) {
          return reply(400, { error: 'Use limit 1–100 and either a valid before or after message ID' });
        }
        const query = new URLSearchParams({ limit: String(limit) });
        if (before) query.set('before', before);
        if (after) query.set('after', after);
        const data = await client.rest.get(Routes.channelMessages(readChannel), { query });
        data.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
        return reply(200, { messages: data.map(message), oldest_id: data[0]?.id ?? null, newest_id: data.at(-1)?.id ?? null });
      }
      if (req.method === 'GET' && (single || threadPath?.[2])) {
        return reply(200, message(await client.rest.get(Routes.channelMessage(readChannel, single ? single[1] : threadPath[2]))));
      }
      if (req.method === 'POST' && path === '/messages') {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > 16384) {
            req.resume();
            return reply(413, { error: 'Request body too large' });
          }
          chunks.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'Invalid JSON' }); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return reply(400, { error: 'Expected a JSON object' });
        const mentions = input.mention_user_ids ?? [];
        if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 2000 ||
            typeof input.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,25}$/.test(input.request_id) ||
            !Array.isArray(mentions) || mentions.length > 10 || mentions.some(id => typeof id !== 'string' || !snowflake.test(id)) ||
            (input.reply_to !== undefined && (typeof input.reply_to !== 'string' || !snowflake.test(input.reply_to)))) {
          return reply(400, { error: 'Use content (1–2000 characters), request_id (1–25 letters/digits/_/-), and optional valid reply_to and mention_user_ids' });
        }
        const payload = {
          content: input.content, nonce: input.request_id, enforce_nonce: true,
          allowed_mentions: { parse: [], users: mentions, replied_user: false },
        };
        if (input.reply_to) payload.message_reference = { message_id: input.reply_to, channel_id: channelId, fail_if_not_exists: true };
        const sent = await client.rest.post(Routes.channelMessages(channelId), { body: payload });
        return reply(201, message(sent));
      }
      reply(404, { error: 'Not found' });
    } catch (error) {
      // Never return provider errors or request bodies: they may contain private content/tokens.
      const status = error.status === 403 ? 403 : error.status === 404 ? 404 : 502;
      reply(status, { error: status === 403 ? 'Discord access denied' : status === 404 ? 'Discord message not found' : 'Discord request failed' });
    }
  });
  server.requestTimeout = 30000;
  return server;
}
