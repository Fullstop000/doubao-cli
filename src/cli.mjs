import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentSession, getDataDir, listSessions, resolveProfile } from './storage.mjs';
import { cdpStatus } from './cdp.mjs';
import { openConversation, readConversation, sendMessage } from './automation.mjs';

const DEFAULT_APP = '/Applications/Doubao.app';
const CLI_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `Usage:
  doubao status [--profile <name>] [--json]
  doubao profiles [--json]
  doubao sessions list [--profile <name>] [--json]
  doubao sessions current [--profile <name>] [--json]
  doubao sessions open <conversation-id>
  doubao sessions read <conversation-id> [--limit <count>] [--json]
  doubao sessions send <conversation-id> <message> [--wait] [--timeout <seconds>] [--json]
  doubao cdp status [--json]
  doubao cdp launch [--json]
  doubao capabilities [--json]

Environment:
  DOUBAO_APP       Override the Doubao.app path
  DOUBAO_DATA_DIR  Override the Doubao user-data directory
  DOUBAO_CDP_ENDPOINT  CDP endpoint (default: http://127.0.0.1:9225)
`;

function parseOptions(argv) {
  const args = [];
  let profile;
  let json = false;
  let wait = false;
  let timeoutSeconds = 120;
  let limit = 20;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') {
      json = true;
    } else if (argv[index] === '--wait') {
      wait = true;
    } else if (argv[index] === '--profile') {
      profile = argv[index + 1];
      if (!profile) throw new Error('--profile requires a value');
      index += 1;
    } else if (argv[index] === '--timeout') {
      timeoutSeconds = Number(argv[index + 1]);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('--timeout requires a positive number of seconds');
      index += 1;
    } else if (argv[index] === '--limit') {
      limit = Number(argv[index + 1]);
      if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new Error('--limit requires an integer from 1 to 1000');
      index += 1;
    } else {
      args.push(argv[index]);
    }
  }
  return { args, profile, json, wait, timeoutMs: timeoutSeconds * 1000, limit };
}

function output(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function appVersion(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const result = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function appRunning(appPath) {
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Doubao');
  return spawnSync('/usr/bin/pgrep', ['-f', executable]).status === 0;
}

function validateId(value) {
  if (!/^\d{12,24}$/u.test(value || '')) throw new Error('conversation id must contain 12 to 24 digits');
  return value;
}

function sessionWithTitle(profilePath, id) {
  return listSessions(profilePath).find((session) => session.id === id) || { id, title: null };
}

export async function main(argv) {
  const { args, profile: requestedProfile, json, wait, timeoutMs, limit } = parseOptions(argv);
  const [command, subcommand, operand] = args;
  const dataDir = getDataDir();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(CLI_VERSION);
    return;
  }

  if (command === 'profiles') {
    const { readProfiles } = await import('./storage.mjs');
    const profiles = readProfiles(dataDir);
    if (json) output(profiles, true);
    else {
      for (const item of profiles.profiles) {
        const active = item.directory === profiles.lastUsed ? '*' : ' ';
        console.log(`${active} ${item.directory}\t${item.name}`);
      }
    }
    return;
  }

  if (command === 'capabilities') {
    const cdp = await cdpStatus();
    const capabilities = {
      status: true,
      listSessions: true,
      detectCurrentSession: true,
      openSession: true,
      readMessages: cdp.available,
      sendMessages: cdp.available,
      cdp,
      note: cdp.available
        ? 'Message automation is available through the authenticated Doubao renderer over local CDP.'
        : 'Restart Doubao with --remote-debugging-port=9225 to enable message automation.',
    };
    if (json) output(capabilities, true);
    else {
      console.log('status\tyes');
      console.log('sessions list\tyes');
      console.log('sessions current\tyes');
      console.log('sessions open\tyes');
      console.log(`messages read\t${capabilities.readMessages ? 'yes' : 'no'}`);
      console.log(`messages send\t${capabilities.sendMessages ? 'yes' : 'no'}`);
      console.log(`note\t${capabilities.note}`);
    }
    return;
  }

  if (command === 'cdp' && subcommand === 'status') {
    const status = await cdpStatus();
    if (json) output(status, true);
    else {
      console.log(`available\t${status.available ? 'yes' : 'no'}`);
      console.log(`endpoint\t${status.endpoint}`);
      if (status.browser) console.log(`browser\t${status.browser}`);
      if (status.error) console.log(`error\t${status.error}`);
    }
    if (!status.available) process.exitCode = 1;
    return;
  }

  if (command === 'cdp' && subcommand === 'launch') {
    const existing = await cdpStatus();
    if (existing.available) {
      if (json) output(existing, true);
      else console.log(`available\tyes\nendpoint\t${existing.endpoint}`);
      return;
    }
    const appPath = process.env.DOUBAO_APP || DEFAULT_APP;
    if (appRunning(appPath)) throw new Error('Doubao is already running without CDP. Quit it completely, then run this command again.');
    const endpoint = new URL(existing.endpoint);
    if (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') {
      throw new Error('cdp launch only supports a localhost DOUBAO_CDP_ENDPOINT');
    }
    const port = endpoint.port || '9225';
    const result = spawnSync('/usr/bin/open', ['-a', appPath, '--args', `--remote-debugging-port=${port}`], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'failed to launch Doubao with CDP');
    let launched = existing;
    for (let attempt = 0; attempt < 30 && !launched.available; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      launched = await cdpStatus();
    }
    if (!launched.available) throw new Error(`Doubao launched, but CDP did not become available at ${existing.endpoint}`);
    if (json) output(launched, true);
    else console.log(`available\tyes\nendpoint\t${launched.endpoint}`);
    return;
  }

  const profile = resolveProfile(dataDir, requestedProfile);

  if (command === 'status') {
    const appPath = process.env.DOUBAO_APP || DEFAULT_APP;
    const sessions = listSessions(profile.path);
    const status = {
      installed: fs.existsSync(appPath),
      running: appRunning(appPath),
      appVersion: appVersion(appPath),
      appPath,
      dataDir,
      profile: { directory: profile.directory, name: profile.name },
      cachedSessions: sessions.length,
    };
    if (json) output(status, true);
    else {
      console.log(`installed\t${status.installed ? 'yes' : 'no'}`);
      console.log(`running\t${status.running ? 'yes' : 'no'}`);
      console.log(`app version\t${status.appVersion || 'unknown'}`);
      console.log(`profile\t${profile.directory} (${profile.name})`);
      console.log(`cached sessions\t${status.cachedSessions}`);
    }
    return;
  }

  if (command !== 'sessions') throw new Error(`unknown command "${command}". Run "doubao help".`);

  if (subcommand === 'list') {
    const sessions = listSessions(profile.path);
    if (json) output(sessions, true);
    else {
      console.log('CONVERSATION ID\tTITLE');
      for (const session of sessions) console.log(`${session.id}\t${session.title}`);
    }
    return;
  }

  if (subcommand === 'current') {
    const id = currentSession(profile.path);
    if (!id) throw new Error('current Doubao session was not found in the local session store');
    const session = sessionWithTitle(profile.path, id);
    if (json) output(session, true);
    else console.log(`${session.id}\t${session.title || ''}`);
    return;
  }

  if (subcommand === 'open') {
    const id = validateId(operand);
    const url = openConversation(id);
    if (json) output({ id, url, opened: true }, true);
    else console.log(`opened\t${id}`);
    return;
  }

  if (subcommand === 'read') {
    const id = validateId(operand);
    const messages = await readConversation(id, { limit, timeoutMs });
    if (json) output({ conversationId: id, messages }, true);
    else for (const item of messages) console.log(`${item.role}\t${item.text.replaceAll('\n', '\\n')}`);
    return;
  }

  if (subcommand === 'send') {
    const id = validateId(operand);
    const message = args.slice(3).join(' ');
    const result = await sendMessage(id, message, { waitForReply: wait, timeoutMs });
    if (json) output(result, true);
    else {
      console.log(`sent\t${result.sent.text}`);
      if (result.reply) console.log(`reply\t${result.reply.text.replaceAll('\n', '\\n')}`);
    }
    return;
  }

  throw new Error(`unknown sessions command "${subcommand || ''}". Run "doubao help".`);
}
