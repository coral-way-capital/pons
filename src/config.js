import { PermissionFlagsBits } from 'discord.js';

export const snowflake = /^\d{17,20}$/;

export function parseChannelIds(env) {
  const ids = [...new Set([env.DISCORD_CHANNEL_ID ?? '', ...(env.DISCORD_CHANNEL_IDS ?? '').split(',')]
    .map(id => id.trim()).filter(Boolean))];
  for (const id of ids) {
    if (!snowflake.test(id)) throw new Error(`Invalid Discord channel ID ${JSON.stringify(id)}: expected 17–20 digits.`);
  }
  if (!ids.length) throw new Error('Set DISCORD_CHANNEL_ID or DISCORD_CHANNEL_IDS to at least one Discord channel ID.');
  return ids;
}

export async function checkChannelPermissions(client, channelIds) {
  for (const id of channelIds) {
    let channel;
    try {
      channel = await client.channels.fetch(id);
      if (!channel || !channel.isTextBased() || !channel.guild || channel.isThread() ||
          !channel.permissionsFor(client.user)?.has([
            PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages,
          ])) {
        throw new Error('Channel unavailable or missing permissions');
      }
      // Check actual history access before reporting readiness; never log message content.
      await channel.messages.fetch({ limit: 1 });
    } catch {
      throw new Error(`Startup failed for channel ${id}${channel?.name ? ` (${JSON.stringify(channel.name)})` : ''}: verify a server text channel with View Channel, Read Message History, and Send Messages.`);
    }
  }
}
