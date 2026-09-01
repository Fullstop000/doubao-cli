import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { currentSession, getDataDir, listSessions, resolveProfile } from './storage.mjs';
import { cdpStatus } from './cdp.mjs';
import { createConversation, openConversation, readConversation, sendMessage } from './automation.mjs';
import { currentModel, listModels, selectModel } from './models.mjs';

const DEFAULT_APP = '/Applications/Doubao.app';
const CLI_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `Usage:
  doubao status [--profile <name>] [--json]
  doubao profiles [--json]
  doubao sessions list [--profile <name>] [--json]
  doubao sessions current [--profile <name>] [--json]
  doubao sessions create [message] [--attach <path>] [--model <model>] [--wait] [--timeout <seconds>] [--json]
  doubao sessions open <conversation-id>
  doubao sessions read <conversation-id> [--limit <count>] [--json]
  doubao sessions send <conversation-id> <message> [--attach <path>] [--model <model>] [--wait] [--timeout <seconds>] [--json]
  doubao models [--json]
  doubao model [--json]
  doubao model select <model> [--json]
  doubao cdp status [--json]
  doubao cdp launch [--yes] [--json]
  doubao capabilities [--json]

Environment:
  DOUBAO_APP       Override the Doubao.app path
  DOUBAO_DATA_DIR  Override the Doubao user-data directory
  DOUBAO_CDP_ENDPOINT  CDP endpoint (default: http://127.0.0.1:9225)
`;

export function parseOptions(argv) {
  const args = [];
  let profile;
  let json = false;
  let yes = false;
  let wait = false;
  let timeoutSeconds = 120;
  let limit = 20;
  let model;
  const attachments = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--') {
      args.push(...argv.slice(index + 1));
      break;
    } else if (argv[index] === '--json') {
      json = true;
    } else if (argv[index] === '--yes') {
      yes = true;
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
    } else if (argv[index] === '--model') {
      model = argv[index + 1];
      if (!model) throw new Error('--model requires a value');
      index += 1;
    } else if (argv[index] === '--attach') {
      const attachment = argv[index + 1];
      if (!attachment || attachment.startsWith('--')) throw new Error('--attach requires a file path');
      attachments.push(attachment);
      index += 1;
    } else {
      args.push(argv[index]);
    }
  }
  return { args, profile, json, yes, wait, timeoutMs: timeoutSeconds * 1000, limit, model, attachments };
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

function appProcessPattern(appPath) {
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Doubao');
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return `^${escaped}([[:space:]]|$)`;
}

function appRunning(appPath) {
  return spawnSync('/usr/bin/pgrep', ['-f', appProcessPattern(appPath)]).status === 0;
}

async function waitForAppExit(appPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!appRunning(appPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !appRunning(appPath);
}

async function quitAppForCdp(appPath) {
  const result = spawnSync('/usr/bin/osascript', [
    '-e',
    'tell application id "com.bot.pc.doubao" to quit',
  ], { encoding: 'utf8' });
  if (result.status === 0 && await waitForAppExit(appPath, 5000)) return;

  const terminated = spawnSync('/usr/bin/pkill', ['-TERM', '-f', appProcessPattern(appPath)], { encoding: 'utf8' });
  if (terminated.status !== 0 && terminated.status !== 1) {
    throw new Error(terminated.stderr.trim() || result.stderr.trim() || 'failed to stop Doubao before enabling CDP');
  }
  if (!await waitForAppExit(appPath, 10_000)) {
    throw new Error('Doubao did not quit after SIGTERM. Quit it manually, then run "doubao cdp launch" again.');
  }
}

async function confirmCdpRestart({ json, yes }) {
  if (yes) return;
  if (json || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Doubao must restart to enable CDP. Re-run "doubao cdp launch --yes" to confirm.');
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question('Doubao must restart to enable CDP. Continue? [y/N] ');
    if (!/^(?:y|yes)$/iu.test(answer.trim())) {
      throw new Error('CDP launch cancelled; Doubao was not restarted.');
    }
  } finally {
    prompt.close();
  }
}

async function waitForAutomationReady(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await listModels();
      if (result.models.length) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Doubao CDP is listening, but the chat renderer is not ready: ${lastError?.message || 'timed out'}`);
}

function validateId(value) {
  if (!/^\d{12,24}$/u.test(value || '')) throw new Error('conversation id must contain 12 to 24 digits');
  return value;
}

function sessionWithTitle(profilePath, id) {
  return listSessions(profilePath).find((session) => session.id === id) || { id, title: null };
}

export async function main(argv) {
  const { args, profile: requestedProfile, json, yes, wait, timeoutMs, limit, model, attachments } = parseOptions(argv);
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
      createSessions: cdp.available,
      readMessages: cdp.available,
      sendMessages: cdp.available,
      uploadAttachments: cdp.available,
      selectModels: cdp.available,
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
      console.log(`sessions create\t${capabilities.createSessions ? 'yes' : 'no'}`);
      console.log(`messages read\t${capabilities.readMessages ? 'yes' : 'no'}`);
      console.log(`messages send\t${capabilities.sendMessages ? 'yes' : 'no'}`);
      console.log(`attachments upload\t${capabilities.uploadAttachments ? 'yes' : 'no'}`);
      console.log(`models select\t${capabilities.selectModels ? 'yes' : 'no'}`);
      console.log(`note\t${capabilities.note}`);
    }
    return;
  }

  if (command === 'models') {
    const result = await listModels();
    if (json) output(result, true);
    else {
      console.log('SELECTED\tID\tMODEL');
      for (const item of result.models) console.log(`${item.selected ? '*' : ''}\t${item.id}\t${item.name}`);
      if (result.reasoning) console.log(`reasoning\t${result.reasoning}`);
    }
    return;
  }

  if (command === 'model' && (!subcommand || subcommand === 'current')) {
    const result = await currentModel();
    if (json) output(result, true);
    else {
      console.log(`model\t${result.name}`);
      console.log(`id\t${result.id}`);
      if (result.reasoning) console.log(`reasoning\t${result.reasoning}`);
    }
    return;
  }

  if (command === 'model' && subcommand === 'select') {
    const requestedModel = args.slice(2).join(' ');
    const result = await selectModel(requestedModel);
    if (json) output(result, true);
    else {
      console.log(`model\t${result.name}`);
      console.log(`changed\t${result.changed ? 'yes' : 'no'}`);
      if (result.reasoning) console.log(`reasoning\t${result.reasoning}`);
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
      await waitForAutomationReady();
      if (json) output(existing, true);
      else console.log(`available\tyes\nendpoint\t${existing.endpoint}`);
      return;
    }
    const appPath = process.env.DOUBAO_APP || DEFAULT_APP;
    const endpoint = new URL(existing.endpoint);
    if (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') {
      throw new Error('cdp launch only supports a localhost DOUBAO_CDP_ENDPOINT');
    }
    const port = endpoint.port || '9225';
    const restarted = appRunning(appPath);
    if (restarted) {
      await confirmCdpRestart({ json, yes });
      await quitAppForCdp(appPath);
    }
    const result = spawnSync('/usr/bin/open', ['-a', appPath, '--args', `--remote-debugging-port=${port}`], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'failed to launch Doubao with CDP');
    let launched = existing;
    for (let attempt = 0; attempt < 120 && !launched.available; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      launched = await cdpStatus();
    }
    if (!launched.available) throw new Error(`Doubao launched, but CDP did not become available at ${existing.endpoint}`);
    await waitForAutomationReady();
    const launchResult = { ...launched, launched: true, restarted };
    if (json) output(launchResult, true);
    else console.log(`available\tyes\nendpoint\t${launched.endpoint}\nrestarted\t${restarted ? 'yes' : 'no'}`);
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

  if (subcommand === 'create') {
    const message = args.slice(2).join(' ');
    const result = await createConversation(message, {
      attachments,
      model,
      timeoutMs,
      waitForReply: wait,
    });
    if (json) output(result, true);
    else {
      console.log(`created\t${result.conversationId || 'draft'}`);
      if (result.model) console.log(`model\t${result.model}`);
      for (const attachment of result.attachments || []) console.log(`attachment\t${attachment.name}`);
      if (result.sent) console.log(`sent\t${result.sent.text}`);
      if (result.reply) console.log(`reply\t${result.reply.text.replaceAll('\n', '\\n')}`);
    }
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
    const result = await sendMessage(id, message, { attachments, waitForReply: wait, timeoutMs, model });
    if (json) output(result, true);
    else {
      console.log(`sent\t${result.sent.text}`);
      if (result.model) console.log(`model\t${result.model}`);
      for (const attachment of result.attachments || []) console.log(`attachment\t${attachment.name}`);
      if (result.reply) console.log(`reply\t${result.reply.text.replaceAll('\n', '\\n')}`);
    }
    return;
  }

  throw new Error(`unknown sessions command "${subcommand || ''}". Run "doubao help".`);
}
