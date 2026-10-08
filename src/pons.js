import { Client, Events, GatewayIntentBits } from 'discord.js';
import { createBridge } from './bridge.js';
import { parseChannelIds, checkChannelPermissions } from './config.js';

const { DISCORD_BOT_TOKEN, BRIDGE_TOKEN } = process.env;
let channelIds;
try {
  channelIds = parseChannelIds(process.env);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);
if (!DISCORD_BOT_TOKEN || !BRIDGE_TOKEN || BRIDGE_TOKEN.length < 32 || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Set DISCORD_BOT_TOKEN, BRIDGE_TOKEN (32+ characters), and a valid PORT in .env.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [], repliedUser: false },
});
const server = createBridge(client, channelIds, BRIDGE_TOKEN);

client.once(Events.ClientReady, async () => {
  try {
    await checkChannelPermissions(client, channelIds);
    server.listen(port, '127.0.0.1', () => {
      console.log(`pons connected. Local bridge: http://127.0.0.1:${port}; channels: ${channelIds.join(', ')}`);
    });
  } catch (error) {
    console.error(error.message);
    client.destroy();
    process.exitCode = 1;
  }
});
client.on(Events.Error, () => console.error('Discord connection error; check bot configuration.'));
server.on('error', () => {
  console.error('Local bridge could not start; check whether PORT is already in use.');
  client.destroy();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    client.destroy();
    server.close();
  });
}
client.login(DISCORD_BOT_TOKEN).catch(() => {
  console.error('Discord login failed. Check the local bot token and enable Message Content Intent.');
  client.destroy();
  process.exitCode = 1;
});
