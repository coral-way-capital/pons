const args = process.argv.slice(2);
const channelIndex = args.indexOf('--channel');
let channelId;
if (channelIndex !== -1) {
  channelId = args.splice(channelIndex, 2)[1];
  if (!/^\d{17,20}$/.test(channelId ?? '')) {
    console.error('--channel requires a Discord channel ID (17–20 digits).');
    process.exit(1);
  }
}
const [command = 'health', value, extra] = args;
const paths = { health: '/health', history: '/messages', read: '/messages/', events: '/events', send: '/messages', threads: '/threads', 'thread-history': '/threads/', 'thread-read': '/threads/' };
if (!Object.hasOwn(paths, command) || !process.env.BRIDGE_TOKEN || (['read', 'send', 'thread-history', 'thread-read'].includes(command) && !value) || (command === 'thread-read' && !extra)) {
  console.error('Usage: bun run bridge [--channel <channel-id>] health | history [before-id] | read <message-id> | events [cursor] | send <json> | threads [active|archived_public|archived_private] [before] | thread-history <thread-id> [before-id] | thread-read <thread-id> <message-id>');
  process.exit(1);
}
let path = paths[command];
if (command === 'history' && value) path += `?before=${encodeURIComponent(value)}`;
if (command === 'events' && value) path += `?cursor=${encodeURIComponent(value)}`;
if (command === 'read') path += encodeURIComponent(value);
if (command === 'threads') {
  const query = new URLSearchParams({ state: value ?? 'active' });
  if (extra) query.set('before', extra);
  path += `?${query}`;
}
if (command === 'thread-history' || command === 'thread-read') {
  path += `${encodeURIComponent(value)}/messages`;
  if (command === 'thread-read') path += `/${encodeURIComponent(extra)}`;
  else if (extra) path += `?before=${encodeURIComponent(extra)}`;
}
if (channelId && !['health', 'events'].includes(command)) path = `/channels/${channelId}${path}`;
try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8787}${path}`, {
    method: command === 'send' ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${process.env.BRIDGE_TOKEN}`, 'Content-Type': 'application/json' },
    ...(command === 'send' ? { body: value } : {}),
    signal: AbortSignal.timeout(30000),
  });
  console.log(JSON.stringify(await response.json(), null, 2));
  if (!response.ok) process.exitCode = 1;
} catch {
  console.error('Cannot reach the local bridge. Start pons with bun start and verify PORT.');
  process.exitCode = 1;
}
