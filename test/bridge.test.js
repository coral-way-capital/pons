import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { REST } from 'discord.js';
import { createBridge } from '../src/bridge.js';

const channel = '1000000000000073215';
const bot = '1000000000000086190';
const token = 'test-bridge-token-at-least-32-characters';
const secondChannel = '10000000000000002';
const outsideChannel = '10000000000000003';

async function setup(t, provider = () => ({ status: 200, data: [] }), channels = channel) {
  let calls = 0;
  const discord = createServer(async (req, res) => {
    calls++;
    let body = '';
    for await (const chunk of req) body += chunk;
    const result = provider(req.method, new URL(req.url, 'http://localhost'), body && JSON.parse(body));
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.data));
  });
  discord.listen(0, '127.0.0.1');
  await once(discord, 'listening');
  const client = new EventEmitter();
  client.user = { id: bot };
  client.connected = true;
  client.isReady = () => client.connected;
  client.channels = { cache: new Map() };
  client.rest = new REST({ api: `http://127.0.0.1:${discord.address().port}`, retries: 0 }).setToken('synthetic-discord-token');
  const bridge = createBridge(client, channels, token);
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  t.after(async () => {
    await Promise.all([new Promise(resolve => bridge.close(resolve)), new Promise(resolve => discord.close(resolve))]);
  });
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${bridge.address().port}${path}`, {
      method: options.method ?? 'GET', headers: { Authorization: `Bearer ${token}`, ...options.headers },
    }, async res => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      resolve(new Response(Buffer.concat(chunks), { status: res.statusCode }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
  return { client, request, calls: () => calls, port: bridge.address().port };
}

test('HTTP boundary denies unauthorized/browser requests and rejects invalid writes before Discord', async t => {
  const { request, calls, client } = await setup(t);
  for (const headers of [{ Authorization: '' }, { Authorization: 'Bearer wrong' }]) {
    assert.equal((await request('/messages', { headers })).status, 401);
  }
  assert.equal((await request('/messages', { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await request('/messages', { headers: { Host: 'evil.example' } })).status, 403);
  for (const body of ['not json', 'null', '{}', JSON.stringify({ content: 'hello', request_id: 'ok', mention_user_ids: ['@everyone'] }), JSON.stringify({ content: 'x'.repeat(2001), request_id: 'ok' })]) {
    assert.equal((await request('/messages', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/messages', { method: 'POST', body: 'x'.repeat(17000) })).status, 413);
  assert.equal((await request('/channels/123/messages')).status, 404);
  assert.equal((await request('/messages?limit=101')).status, 400);
  assert.equal((await request(`/messages?before=${bot}&after=${bot}`)).status, 400);
  assert.equal(calls(), 0);
  client.connected = false;
  assert.equal((await request('/health')).status, 503);
  assert.equal((await request('/messages')).status, 503);
});

test('history and sends use only the configured channel, preserve bot output, and suppress unsolicited mentions', async t => {
  const { request } = await setup(t, (method, url, body) => {
    assert.equal(url.pathname, `/v10/channels/${channel}/messages`);
    if (method === 'GET') {
      assert.equal(url.searchParams.get('before'), '1000000000000086200');
      return { status: 200, data: [
        { id: '1000000000000086192', channel_id: channel, author: { id: bot, username: 'pons', bot: true }, content: 'second' },
        { id: '1000000000000086191', channel_id: channel, author: { id: '1000000000000086199', username: 'peer', bot: true }, content: 'first', embeds: [{ description: 'peer status' }] },
      ] };
    }
    assert.equal(body.content, 'Hola 👋 @everyone');
    assert.equal(body.nonce, 'request-1');
    assert.equal(body.enforce_nonce, true);
    assert.deepEqual(body.allowed_mentions, { parse: [], users: [], replied_user: false });
    assert.equal(body.message_reference.channel_id, channel);
    assert.equal(body.message_reference.fail_if_not_exists, true);
    return { status: 200, data: { id: '1000000000000086201', channel_id: channel, author: { id: bot, username: 'pons', bot: true }, content: body.content } };
  });
  const history = await (await request('/messages?before=1000000000000086200')).json();
  assert.equal(history.messages[0].content, 'first');
  assert.equal(history.messages[0].author.bot, true);
  assert.equal(history.messages[0].embeds[0].description, 'peer status');
  assert.equal(history.oldest_id, '1000000000000086191');
  assert.equal(history.newest_id, '1000000000000086192');
  const sent = await request('/messages', { method: 'POST', body: JSON.stringify({ content: 'Hola 👋 @everyone', request_id: 'request-1', reply_to: '1000000000000086191', channel_id: '1000000000000086000' }) });
  assert.equal(sent.status, 201);
  assert.equal((await sent.json()).is_self, true);
});

test('events isolate the channel, retain edits/deletions, identify self output, and report gaps', async t => {
  const { client, request } = await setup(t);
  const initial = (await (await request('/health')).json()).cursor;
  client.emit('raw', { t: 'MESSAGE_CREATE', d: { id: '1000000000000086191', channel_id: '1000000000000086000', content: 'private other channel' } });
  assert.deepEqual((await (await request(`/events?cursor=${initial}`)).json()).events, []);
  client.emit('raw', { t: 'MESSAGE_CREATE', d: { id: bot, channel_id: channel, author: { id: bot, bot: true }, content: 'self' } });
  client.emit('raw', { t: 'MESSAGE_UPDATE', d: { id: bot, channel_id: channel, content: 'edited' } });
  client.emit('raw', { t: 'MESSAGE_DELETE', d: { id: bot, channel_id: channel } });
  client.emit('shardDisconnect');
  const result = await (await request(`/events?cursor=${initial}`)).json();
  assert.deepEqual(result.events.map(event => event.type), ['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE', 'CONNECTION_GAP']);
  assert.equal(result.events[0].data.is_self, true);
  assert.equal(result.events[1].data.content, 'edited');
  assert.deepEqual((await (await request(`/events?cursor=${result.cursor}`)).json()).events, []);
  assert.equal((await request('/events?cursor=other-session:1')).status, 409);
  for (let i = 0; i < 1001; i++) client.emit('raw', { t: 'MESSAGE_DELETE', d: { id: bot, channel_id: channel } });
  assert.equal((await request(`/events?cursor=${result.cursor}`)).status, 409);
  assert.equal((await (await request('/events')).json()).truncated, true);
});

test('Discord permission failures are surfaced without leaking provider details', async t => {
  const { request } = await setup(t, () => ({ status: 403, data: { code: 50013, message: 'secret-provider-detail' } }));
  const response = await request('/messages');
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Discord access denied' });
});

test('thread listings filter by selected parent and paginate public and joined-private archives', async t => {
  const thread = '1000000000000086300';
  const secondThread = '10000000000000004';
  const archived = parent => ({ id: parent === channel ? thread : secondThread, parent_id: parent, type: 11, name: 'archive', thread_metadata: { archived: true, archive_timestamp: '2026-10-06T12:00:00.000Z' } });
  const { request } = await setup(t, (method, url) => {
    assert.equal(method, 'GET');
    const selected = url.pathname.split('/')[3];
    if ([channel, secondChannel].some(id => url.pathname === `/v10/channels/${id}`)) return { status: 200, data: { id: selected, guild_id: bot } };
    if (url.pathname === `/v10/guilds/${bot}/threads/active`) return { status: 200, data: { threads: [
      { ...archived(channel), thread_metadata: { archived: false } },
      { ...archived(secondChannel), thread_metadata: { archived: false } },
      { ...archived(outsideChannel), id: '1000000000000086301', name: 'other channel' },
    ] } };
    if (url.pathname === `/v10/channels/${selected}/threads/archived/public`) {
      assert.equal(url.searchParams.get('before'), '2026-10-07T12:00:00.000Z');
      assert.equal(url.searchParams.get('limit'), '2');
      return { status: 200, data: { threads: [archived(selected)], has_more: true } };
    }
    assert.equal(url.pathname, `/v10/channels/${selected}/users/@me/threads/archived/private`);
    assert.equal(url.searchParams.get('before'), archived(selected).id);
    return { status: 200, data: { threads: [{ ...archived(selected), type: 12 }], has_more: false } };
  }, [channel, secondChannel]);
  for (const [prefix, selected] of [['', channel], [`/channels/${channel}`, channel], [`/channels/${secondChannel}`, secondChannel]]) {
    const active = await request(`${prefix}/threads`);
    assert.equal(active.status, 200);
    assert.deepEqual((await active.json()).threads.map(item => item.id), [selected === channel ? thread : secondThread]);
    const publicPage = await (await request(`${prefix}/threads?state=archived_public&limit=2&before=2026-10-07T12%3A00%3A00.000Z`)).json();
    assert.equal(publicPage.threads[0].parent_id, selected);
    assert.equal(publicPage.has_more, true);
    assert.equal(publicPage.next_before, '2026-10-06T12:00:00.000Z');
    const privatePage = await (await request(`${prefix}/threads?state=archived_private&before=${selected === channel ? thread : secondThread}`)).json();
    assert.equal(privatePage.threads[0].parent_id, selected);
    assert.equal(privatePage.threads[0].type, 12);
    assert.equal(privatePage.next_before, null);
    for (const query of ['state=unknown', 'state=active&before=bad', 'state=archived_public&before=bad', 'state=archived_private&before=bad', 'limit=101']) {
      assert.equal((await request(`${prefix}/threads?${query}`)).status, 400);
    }
  }
});

test('thread reads recheck parent and access, isolate message routes, and remain read-only', async t => {
  const thread = '1000000000000086300';
  const other = '1000000000000086301';
  const id = '1000000000000086400';
  let revoked = false;
  let messageReads = 0;
  const { request } = await setup(t, (method, url) => {
    assert.equal(method, 'GET');
    if (url.pathname === `/v10/channels/${other}`) return { status: 200, data: { id: other, type: 11, parent_id: bot } };
    if (url.pathname === `/v10/channels/${thread}`) return { status: revoked ? 403 : 200, data: revoked ? { code: 50001, message: 'private detail' } : { id: thread, type: 12, parent_id: channel } };
    messageReads++;
    const data = { id, channel_id: thread, guild_id: bot, author: { id: bot, bot: true }, content: 'thread text' };
    if (url.pathname === `/v10/channels/${thread}/messages/${id}`) return { status: 200, data };
    assert.equal(url.pathname, `/v10/channels/${thread}/messages`);
    assert.equal(url.searchParams.get('after'), '1000000000000086399');
    return { status: 200, data: [data] };
  });
  const historyResponse = await request(`/threads/${thread}/messages?after=1000000000000086399`);
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.messages[0].content, 'thread text');
  assert.equal(history.messages[0].url, `https://discord.com/channels/${bot}/${thread}/${id}`);
  assert.equal((await request(`/threads/${thread}/messages/${id}`)).status, 200);
  assert.equal((await request(`/threads/${other}/messages`)).status, 403);
  assert.equal((await request(`/threads/${thread}/messages`, { method: 'POST', body: '{}' })).status, 404);
  revoked = true;
  assert.equal((await request(`/threads/${thread}/messages`)).status, 403);
  assert.equal(messageReads, 2);
});


test('channel routes select allowed channels while legacy routes retain the default', async t => {
  const seen = [];
  const id = '10000000000000004';
  const { request } = await setup(t, (method, url, body) => {
    seen.push([method, url.pathname]);
    const selected = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/threads/archived/public')) {
      return { status: 200, data: { threads: [{ id, type: 11, parent_id: selected, name: 'allowed' }, { id: bot, type: 11, parent_id: outsideChannel, name: 'private' }] } };
    }
    const data = { id, channel_id: selected, content: body?.content ?? 'history' };
    if (method === 'POST') {
      assert.deepEqual(body.allowed_mentions, { parse: [], users: [], replied_user: false });
      assert.equal(body.message_reference.channel_id, selected);
    }
    return { status: 200, data: method === 'GET' && url.pathname.endsWith('/messages') ? [data] : data };
  }, [channel, secondChannel]);
  for (const [prefix, expected] of [['', channel], [`/channels/${channel}`, channel], [`/channels/${secondChannel}`, secondChannel]]) {
    const history = await request(`${prefix}/messages`);
    assert.equal(history.status, 200);
    assert.equal((await history.json()).messages[0].channel_id, expected);
    assert.equal((await (await request(`${prefix}/messages/${id}`)).json()).channel_id, expected);
    const sent = await request(`${prefix}/messages`, { method: 'POST', body: JSON.stringify({ content: 'hello @everyone', request_id: 'multi-send', reply_to: id, channel_id: outsideChannel }) });
    assert.equal(sent.status, 201);
    assert.equal((await sent.json()).channel_id, expected);
    const threads = await (await request(`${prefix}/threads?state=archived_public`)).json();
    assert.deepEqual(threads.threads.map(thread => thread.parent_id), [expected]);
  }
  assert.equal(seen.length, 12);
  const health = await (await request('/health')).json();
  assert.equal(health.channel_id, channel);
  assert.deepEqual(health.channel_ids, [channel, secondChannel]);
});

test('new routes require auth and deny unlisted or malformed ids before contacting Discord', async t => {
  const { request, calls } = await setup(t, undefined, [channel, secondChannel]);
  const thread = '10000000000000004';
  const id = '10000000000000005';
  for (const path of [`/channels/${secondChannel}/messages`, `/channels/${secondChannel}/messages/${id}`, `/channels/${secondChannel}/threads`, `/channels/${secondChannel}/threads/${thread}/messages`, `/channels/${secondChannel}/threads/${thread}/messages/${id}`, '/events', '/health']) {
    for (const method of ['GET', 'POST']) {
      assert.equal((await request(path, { method, headers: { Authorization: '' } })).status, 401);
    }
  }
  for (const path of [`/channels/${outsideChannel}/messages`, `/channels/${outsideChannel}/messages/${id}`, `/channels/${outsideChannel}/threads`, `/channels/${outsideChannel}/threads/${thread}/messages`]) {
    for (const method of ['GET', 'POST']) {
      const response = await request(path, { method, body: '{}' });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'Access denied' });
    }
  }
  for (const path of ['/channels/bad/messages', `/channels/${secondChannel}/messages/bad`, `/channels/${secondChannel}/threads/bad/messages`, `/channels/${secondChannel}/threads/${thread}/messages/bad`, '/threads/bad/messages', `/threads/${thread}/messages/bad`, '/messages/bad']) {
    assert.equal((await request(path)).status, 404);
  }
  assert.equal(calls(), 0);
});

test('thread routes verify the fetched parent instead of a supplied channel', async t => {
  const thread = '10000000000000004';
  const id = '10000000000000005';
  let parent = secondChannel;
  let messageReads = 0;
  const { request } = await setup(t, (method, url) => {
    if (url.pathname === `/v10/channels/${thread}`) return { status: 200, data: { id: thread, type: 11, parent_id: parent } };
    messageReads++;
    const data = { id, channel_id: thread, content: 'allowed thread' };
    return { status: 200, data: url.pathname.endsWith('/messages') ? [data] : data };
  }, [channel, secondChannel]);
  const prefix = `/channels/${secondChannel}/threads/${thread}/messages`;
  assert.equal((await request(prefix)).status, 200);
  assert.equal((await request(`${prefix}/${id}`)).status, 200);
  for (const path of [`/threads/${thread}/messages`, `/channels/${channel}/threads/${thread}/messages`]) {
    assert.equal((await request(path)).status, 403);
  }
  parent = outsideChannel;
  for (const path of [prefix, `${prefix}/${id}`]) {
    const response = await request(path);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Access denied' });
  }
  assert.equal(messageReads, 2);
  assert.equal((await request(prefix, { method: 'POST', body: '{}' })).status, 404);
});

test('events include every allowed channel and verified child thread with channel metadata', async t => {
  const thread = '10000000000000004';
  const outsideThread = '10000000000000005';
  const { client, request } = await setup(t, undefined, [channel, secondChannel]);
  client.channels.cache.set(thread, { type: 11, parentId: secondChannel });
  client.channels.cache.set(outsideThread, { type: 12, parentId: outsideChannel });
  client.channels.cache.set(outsideChannel, { type: 0 });
  for (const selected of [channel, secondChannel, thread, outsideChannel, outsideThread]) {
    for (const type of ['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_DELETE_BULK']) {
      client.emit('raw', { t: type, d: { id: bot, ids: [bot], channel_id: selected, parent_channel_id: channel, content: 'event' } });
    }
  }
  client.emit('shardDisconnect');
  const { events } = await (await request('/events')).json();
  assert.equal(events.length, 13);
  assert.deepEqual(events.slice(0, 12).map(event => event.data.channel_id), [channel, channel, channel, channel, secondChannel, secondChannel, secondChannel, secondChannel, thread, thread, thread, thread]);
  for (const event of events) {
    assert.equal(event.channel_id, event.data.channel_id);
    if (event.channel_id === thread) {
      assert.equal(event.parent_channel_id, secondChannel);
      assert.equal(event.data.parent_channel_id, secondChannel);
    } else {
      assert.equal(event.data.parent_channel_id, undefined);
    }
  }
  assert.equal(events.at(-1).channel_id, null);
  assert.equal(events.at(-1).data.recover_with, 'GET /messages?after=<last-message-id>');
});


test('uncached event channels are resolved before admitting child threads and fail closed', async t => {
  const thread = '10000000000000004';
  const outsideThread = '10000000000000005';
  const inaccessible = '10000000000000006';
  const { client, request, calls } = await setup(t, (method, url) => {
    const id = url.pathname.split('/').at(-1);
    if (id === inaccessible) return { status: 403, data: { code: 50001, message: 'private detail' } };
    return { status: 200, data: { id, type: id === outsideChannel ? 0 : 11, parent_id: id === outsideThread ? outsideChannel : secondChannel } };
  }, [channel, secondChannel]);
  const pending = [];
  const get = client.rest.get.bind(client.rest);
  client.rest.get = (...args) => {
    const result = get(...args);
    pending.push(result.catch(() => {}));
    return result;
  };
  for (const id of [thread, outsideThread, outsideChannel, inaccessible]) {
    client.emit('raw', { t: 'MESSAGE_CREATE', d: { id: bot, channel_id: id, content: 'event', parent_channel_id: channel } });
  }
  for (const type of ['MESSAGE_UPDATE', 'MESSAGE_DELETE']) {
    client.emit('raw', { t: type, d: { id: bot, channel_id: thread, content: 'edited' } });
  }
  client.emit('raw', { t: 'MESSAGE_CREATE', d: { channel_id: 'bad' } });
  await Promise.all(pending);
  const { events } = await (await request('/events')).json();
  assert.equal(calls(), 4);
  assert.deepEqual(events.map(event => event.type), ['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE']);
  assert.equal(events[0].data.channel_id, thread);
  assert.equal(events[0].data.parent_channel_id, secondChannel);
});

test('CLI channel selection uses new routes and keeps the default when omitted', async t => {
  const { port, calls } = await setup(t, (method, url) => ({ status: 200, data: [{ id: bot, channel_id: url.pathname.split('/')[3], content: 'CLI history' }] }), [channel, secondChannel]);
  for (const [args, expected] of [[[], channel], [['--channel', secondChannel], secondChannel]]) {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/client.js', ...args, 'history'], {
      env: { BRIDGE_TOKEN: token, PORT: String(port) }, stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = await new Response(child.stdout).text();
    assert.equal(await child.exited, 0);
    assert.equal(JSON.parse(stdout).messages[0].channel_id, expected);
  }
  const invalid = Bun.spawn([process.execPath, '--no-env-file', 'scripts/client.js', '--channel', 'bad', 'history'], {
    env: { BRIDGE_TOKEN: token, PORT: String(port) }, stdout: 'pipe', stderr: 'pipe',
  });
  assert.match(await new Response(invalid.stderr).text(), /17–20 digits/);
  assert.equal(await invalid.exited, 1);
  assert.equal(calls(), 2);
});
