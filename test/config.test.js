import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { parseChannelIds, checkChannelPermissions } from '../src/config.js';

const first = '10000000000000001';
const second = '10000000000000002';
const third = '10000000000000003';

test('channel configuration trims, deduplicates in order, and gives legacy configuration precedence', () => {
  for (const [env, expected] of [
    [{ DISCORD_CHANNEL_ID: first }, [first]],
    [{ DISCORD_CHANNEL_IDS: ` , ${second}, ${first},,${second}, ${third}, ` }, [second, first, third]],
    [{ DISCORD_CHANNEL_ID: ` ${first} `, DISCORD_CHANNEL_IDS: ` ${second},${first},,${second},${third}` }, [first, second, third]],
    [{ DISCORD_CHANNEL_ID: '', DISCORD_CHANNEL_IDS: second }, [second]],
    [{ DISCORD_CHANNEL_IDS: '12345678901234567890' }, ['12345678901234567890']],
  ]) {
    assert.deepEqual(parseChannelIds(env), expected);
  }
});

test('channel configuration rejects invalid entries by name and requires at least one channel', () => {
  for (const invalid of ['1234567890123456', '123456789012345678901', 'not-a-channel', '12345678901234567x']) {
    for (const env of [{ DISCORD_CHANNEL_IDS: `${first}, ${invalid}` }, { DISCORD_CHANNEL_ID: invalid, DISCORD_CHANNEL_IDS: first }]) {
      assert.throws(() => parseChannelIds(env), error => error.message.includes(invalid) && error.message.includes('17–20 digits'));
    }
  }
  for (const env of [{}, { DISCORD_CHANNEL_ID: ' ', DISCORD_CHANNEL_IDS: ' , , ' }]) {
    assert.throws(() => parseChannelIds(env), /Set DISCORD_CHANNEL_ID or DISCORD_CHANNEL_IDS/);
  }
});

function startupClient(overrides = {}) {
  const visits = [];
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages];
  const client = { user: { id: third }, channels: { fetch: async id => {
    visits.push(`channel:${id}`);
    return {
      name: id === second ? 'second-test-channel' : 'first-test-channel',
      guild: {}, isTextBased: () => true, isThread: () => false,
      permissionsFor: () => new PermissionsBitField(required),
      messages: { fetch: async options => {
        assert.deepEqual(options, { limit: 1 });
        visits.push(`history:${id}`);
      } },
      ...(id === second ? overrides : {}),
    };
  } } };
  return { client, visits };
}

test('startup verifies permissions and actual history access for every configured channel', async () => {
  const { client, visits } = startupClient();
  await checkChannelPermissions(client, [first, second]);
  assert.deepEqual(visits, [`channel:${first}`, `history:${first}`, `channel:${second}`, `history:${second}`]);
});

test('startup identifies a failing channel and name without leaking provider errors', async () => {
  for (const overrides of [
    { permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) },
    { messages: { fetch: async () => { throw new Error('private-provider-detail'); } } },
    { isThread: () => true },
  ]) {
    const { client } = startupClient(overrides);
    await assert.rejects(checkChannelPermissions(client, [first, second]), error => {
      assert.ok(error.message.includes(second));
      assert.ok(error.message.includes('second-test-channel'));
      assert.ok(!error.message.includes('private-provider-detail'));
      return true;
    });
  }
  await assert.rejects(checkChannelPermissions({ channels: { fetch: async () => { throw new Error('private-provider-detail'); } } }, [second]), error => error.message.includes(second) && !error.message.includes('private-provider-detail'));
});

test('invalid channel configuration exits startup non-zero before Discord login', async () => {
  const child = Bun.spawn([process.execPath, '--no-env-file', 'src/pons.js'], {
    env: { DISCORD_CHANNEL_IDS: `${first}, invalid-channel` }, stdout: 'pipe', stderr: 'pipe',
  });
  const stderr = await new Response(child.stderr).text();
  assert.equal(await child.exited, 1);
  assert.match(stderr, /Invalid Discord channel ID "invalid-channel"/);
  assert.ok(!stderr.includes('Discord login failed'));
});
