import { parseArguments } from '../dist/command/parser.mjs';
import { rootHelp, commandHelp } from '../dist/command/help.mjs';
import { validateCliOptions } from './cli-validation.mjs';
import { createScheduledTaskService } from './scheduled-tasks.mjs';
import { rendererJsonClient, goalAvailability, desktopVersion, GOAL_MIN_VERSION } from './features.mjs';
import fs from 'node:fs';
import { readUsage, formatUsage } from './usage.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { getDataDir, readProfiles, resolveProfile } from './storage.mjs';
import { sessionIndex, listDesktopSessions } from './sessions.mjs';
import { SESSION_ACTIONS, sessionMutationInput, mutateApiSession } from './session-actions.mjs';
import { desktopListClient } from './desktop-list-client.mjs';
import { listProfiles, formatProfiles } from './profiles.mjs';
import { cdpStatus, withChatClient } from './cdp.mjs';
import { listConnectors, registerConnector, removeConnector } from './mcp.mjs';
import { createConversation, openConversation, readConversation, sendMessage, setConversationReasoning, stopConversation, taskStatus, waitConversation } from './automation.mjs';
import { currentModel, listModels, selectModel } from './models.mjs';
import {
  checkForUpdate,
  cacheUpdateCheck,
  installUpdate,
  maybeAutoUpdate,
  maybeUpdateReminder,
  readUpdateState,
  setAutoUpdate,
  setUpdateNotifications,
  shouldCheckUpdateReminder,
  updateStatePath,
} from './update.mjs';
import { validateReply, validateSchema } from './validate.mjs';
import { resolvePermission } from './permissions.mjs';
import { createProject, listProjects, runtimeAvailability } from './context.mjs';
import { currentApp, resolvePlatform, withApp } from './app.mjs';
import { executeHeadless } from './headless.mjs';
import { headlessOptionsForHelp } from './options-contract.mjs';
import { runSkinCommand } from './skin/index.mjs';
const CLI_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = rootHelp('desktop');
const HEADLESS_HELP = rootHelp('headless');

export function parseOptions(argv) {
  const { options, explicitOptions } = parseArguments(argv, resolvePermission);
  if (options.helpPath) return options;
  return validateCliOptions(options, explicitOptions);
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
  const executable = path.join(appPath, 'Contents', 'MacOS', currentApp().name);
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
    `tell application id ${JSON.stringify(currentApp().bundleId)} to quit`,
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
    throw new Error(`${currentApp().name} must restart to enable CDP. Re-run "doubao --app ${currentApp().id} cdp launch --yes" to confirm.`);
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${currentApp().name} must restart to enable CDP. Continue? [y/N] `);
    if (!/^(?:y|yes)$/iu.test(answer.trim())) {
      throw new Error(`CDP launch cancelled; ${currentApp().name} was not restarted.`);
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

async function runConfiguredAutoUpdate(command, json) {
  if (['help', '--help', '-h', 'version', '--version', '-v', 'update'].includes(command)) return;
  const result = await maybeAutoUpdate(CLI_VERSION);
  if (result.updated) {
    if (!json) console.error(`doubao: automatically updated to ${result.latestVersion}; the new version applies next run`);
  } else if (result.error && !json) {
    console.error(`doubao: automatic update failed: ${result.error}`);
  }
  return result;
}

// Validates the reply of a create/send result when --expect-json or
// --reply-schema is given. Marks the result with replyValid and sets the
// exit code on failure so callers (e.g. Sprout) can retry.
function loadReplySchema({ replySchema }) {
  if (!replySchema) return null;
  try {
    const schema = JSON.parse(fs.readFileSync(replySchema, 'utf8'));
    validateSchema(schema);
    return schema;
  } catch (error) {
    throw new Error(`cannot read reply schema at ${replySchema}: ${error.message}`);
  }
}

function validateReplyOption(result, { expectJson, replySchema }, schema) {
  if (!expectJson && !replySchema || result.status && result.status !== 'completed') return result;
  const validation = validateReply(result.reply?.text || '', schema);
  if (!validation.ok) {
    for (const error of validation.errors || []) console.error(`doubao: reply validation failed: ${error}`);
    process.exitCode = 1;
  }
  return { ...result, replyValid: validation.ok };
}

export async function main(argv) {
  const options = parseOptions(argv);
  if (options.helpPath) {
    const helpPlatform = options.platform || options.app || (process.platform === 'linux' ? 'headless' : undefined);
    console.log(commandHelp(options.helpPath, helpPlatform, headlessOptionsForHelp));
    return;
  }
  if (options.args[0] === 'skin') return runSkinCommand(options);
  options.schema = loadReplySchema(options);
  const selectedPlatform = options.platform || options.app || (process.platform === 'linux' ? 'headless' : undefined);
  const app = resolvePlatform(selectedPlatform);
  if (options.targetId) app.targetId = options.targetId;
  if (options.profile && app.id !== 'headless') {
    app.profile = resolveProfile(app.dataDir, options.profile).directory;
    const [command, subcommand] = options.args;
    const usesRenderer = ['models', 'model', 'mcp', 'runtimes', 'projects', 'usage', 'automations'].includes(command)
      || (command === 'sessions' && ['open', 'create', 'send', 'read', 'stop', 'status', 'wait', ...SESSION_ACTIONS].includes(subcommand));
    if (usesRenderer && app.profile !== readProfiles(app.dataDir).lastUsed) {
      throw new Error(`Profile ${app.profile} is not active in ${app.name}; switch profiles in the app before automating it`);
    }
  }
  return withApp(app, async () => {
    const update = await runConfiguredAutoUpdate(options.args[0], options.json);
    const reminder = update?.skipped === 'not-enabled'
      && shouldCheckUpdateReminder({ command: options.args[0], json: options.json })
      ? maybeUpdateReminder(CLI_VERSION) : null;
    try { return await run(options); }
    catch (error) {
      if (!error.result) throw error;
      output({ ...error.result, error: error.code || 'task_error', message: error.message }, options.json);
      process.exitCode = 1;
    }
    finally {
      const notification = await reminder;
      if (notification) console.error(`doubao: update available: ${notification.currentVersion} -> ${notification.latestVersion}; run "doubao update"`);
    }
  });
}

async function run(options) {
  const { args, profile: requestedProfile, runId, json, yes, wait, timeoutMs, limit, all, archived, model, reasoning, attachments, workspace, noSkills, permission, runtime, project, enterpriseKnowledge, expectJson, replySchema, mcps, commandPath, commandArgs, envPairs } = options;
  const isolation = { runtime, project, enterpriseKnowledge, workspace, skillPaths: noSkills ? [] : undefined, permission };
  const [command, subcommand, operand] = args;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(currentApp().id === 'headless' ? HEADLESS_HELP : HELP);
    return;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(CLI_VERSION);
    return;
  }

  if (command === 'update') {
    if (subcommand === 'notify') {
      const action = operand || 'status';
      if (!['on', 'off', 'status'].includes(action)) throw new Error('update notify requires on, off, or status');
      const state = action === 'status' ? await readUpdateState() : await setUpdateNotifications(action === 'on');
      const result = {
        enabled: state.updateNotifications,
        lastCheckedAt: state.lastCheckedAt,
        lastNotifiedAt: state.lastNotifiedAt,
        latestVersion: state.latestVersion,
        settingsPath: updateStatePath(),
      };
      if (json) output(result, true);
      else {
        console.log(`update notifications\t${result.enabled ? 'on' : 'off'}`);
        if (result.latestVersion) console.log(`latest\t${result.latestVersion}`);
        if (result.lastCheckedAt) console.log(`last checked\t${result.lastCheckedAt}`);
        if (result.lastNotifiedAt) console.log(`last notified\t${result.lastNotifiedAt}`);
      }
      return;
    }
    if (subcommand === 'auto') {
      const action = operand || 'status';
      if (!['on', 'off', 'status'].includes(action)) {
        throw new Error('update auto requires on, off, or status');
      }
      const state = action === 'status'
        ? await readUpdateState()
        : await setAutoUpdate(action === 'on');
      const result = {
        enabled: state.autoUpdate,
        lastCheckedAt: state.lastCheckedAt,
        lastUpdatedVersion: state.lastUpdatedVersion,
        settingsPath: updateStatePath(),
      };
      if (json) output(result, true);
      else {
        console.log(`automatic updates\t${result.enabled ? 'on' : 'off'}`);
        if (result.lastCheckedAt) console.log(`last checked\t${result.lastCheckedAt}`);
        if (result.lastUpdatedVersion) console.log(`last updated\t${result.lastUpdatedVersion}`);
      }
      return;
    }

    if (subcommand && subcommand !== 'check') {
      throw new Error(`unknown update command "${subcommand}". Run "doubao help".`);
    }
    const check = await checkForUpdate(CLI_VERSION);
    await cacheUpdateCheck(check);
    if (subcommand === 'check') {
      if (json) output(check, true);
      else {
        console.log(`current\t${check.currentVersion}`);
        console.log(`latest\t${check.latestVersion}`);
        console.log(`update available\t${check.updateAvailable ? 'yes' : 'no'}`);
      }
      return;
    }
    const result = check.updateAvailable
      ? { ...check, ...installUpdate(check.latestVersion, { inherit: !json }) }
      : { ...check, updated: false };
    if (result.updated) await cacheUpdateCheck(result);
    if (json) output(result, true);
    else if (result.updated) console.log(`updated\t${result.latestVersion}`);
    else console.log(`up to date\t${result.currentVersion}`);
    return;
  }

  if (currentApp().id === 'headless') {
    const result = await executeHeadless(options);
    const validated = validateReplyOption(result, { expectJson, replySchema }, options.schema);
    if ((wait || command === 'sessions' && subcommand === 'wait') && validated.status && validated.status !== 'completed') process.exitCode = 1;
    if (command === 'sessions' && subcommand === 'stop' && validated.stopped === false) process.exitCode = 1;
    if (command === 'sessions' && subcommand === 'list' && !json) {
      printSessionList(validated);
    } else output(command === 'login' && !json ? 'Doubao Headless is signed in and ready.' : validated, json);
    return;
  }

  const dataDir = getDataDir();

  if (command === 'profiles') {
    const profiles = await listProfiles(dataDir);
    if (json) output(profiles, true);
    else output(formatProfiles(profiles), false);
    return;
  }

  if (command === 'automations') {
    const result = await withChatClient(async client => {
      const service = createScheduledTaskService(await rendererJsonClient(client), { timeoutMs });
      if (subcommand === 'list') return { automations: await service.list() };
      if (subcommand === 'get') return { automation: await service.get(operand) || null };
      if (subcommand === 'create') return service.create(options.automationInput);
      if (subcommand === 'update') return service.update(operand, options.automationInput);
      return service.delete(operand);
    });
    output(result, json);
    return;
  }

  if (command === 'capabilities') {
    const cdp = await cdpStatus();
    const goalMode = cdp.available
      ? await withChatClient(async client => goalAvailability(await rendererJsonClient(client), desktopVersion())).catch(error => ({ available: false, minimumVersion: GOAL_MIN_VERSION, reason: error.message }))
      : { available: false, minimumVersion: GOAL_MIN_VERSION, reason: 'cdp_unavailable' };
    const capabilities = {
      status: true,
      goalMode,
      automations: cdp.available,
      listSessions: true,
      detectCurrentSession: true,
      openSession: true,
      createSessions: cdp.available,
      sessionActions: cdp.available ? SESSION_ACTIONS : [],
      readMessages: cdp.available,
      sendMessages: cdp.available,
      stopGeneration: cdp.available,
      taskStatus: cdp.available,
      waitForTurn: cdp.available,
      cancelTaskTree: cdp.available,
      mcpConnectors: cdp.available,
      uploadAttachments: cdp.available,
      selectModels: cdp.available,
      usage: cdp.available,
      selfUpdate: true,
      automaticUpdates: true,
      cdp,
      note: cdp.available
        ? 'Message automation is available through the authenticated Doubao renderer over local CDP.'
        : `Run doubao --app ${currentApp().id} cdp launch to enable message automation.`,
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
      console.log(`generation stop\t${capabilities.stopGeneration ? 'yes' : 'no'}`);
      console.log(`sessions status/wait\t${capabilities.taskStatus ? 'yes' : 'no'}`);
      console.log(`mcp connectors\t${capabilities.mcpConnectors ? 'yes' : 'no'}`);
      console.log(`attachments upload\t${capabilities.uploadAttachments ? 'yes' : 'no'}`);
      console.log(`models select\t${capabilities.selectModels ? 'yes' : 'no'}`);
      console.log(`usage\t${capabilities.usage ? 'yes' : 'no'}`);
      console.log(`goal mode\t${goalMode.available ? 'yes' : 'no'}`);
      console.log(`automations\t${capabilities.automations ? 'yes' : 'no'}`);
      console.log('self update\tyes');
      console.log('automatic updates\tyes');
      console.log(`note\t${capabilities.note}`);
    }
    return;
  }

  if (command === 'usage') {
    if (subcommand) throw new Error('usage accepts no subcommand. Run \"doubao help\".');
    const result = await withChatClient(readUsage);
    output(json ? result : formatUsage(result), json);
    return;
  }

  if (command === 'runtimes') {
    const result = await withChatClient(runtimeAvailability);
    if (json) output(result, true);
    else for (const item of result.runtimes) console.log(`${item.id}\t${item.name}\t${item.available ? 'ready' : item.status}`);
    return;
  }
  if (command === 'projects' && subcommand === 'list') {
    const result = await withChatClient(client => listProjects(client, timeoutMs));
    if (json) output(result, true);
    else for (const item of result) console.log(`${item.id}\t${item.name}`);
    return;
  }
  if (command === 'projects' && subcommand === 'create') {
    const result = await withChatClient(client => createProject(client, { name: args.slice(2).join(' '), workspace }));
    if (json) output(result, true);
    else console.log(`${result.id}\t${result.name}`);
    return;
  }

  if (command === 'mcp') {
    if (subcommand === 'register') {
      const name = args.slice(2).join(' ');
      if (!name) throw new Error('mcp register requires a connector name');
      if (!commandPath) throw new Error('mcp register requires --command <path> of the stdio MCP server');
      if (!fs.existsSync(commandPath)) throw new Error(`command not found: ${commandPath}`);
      const env = Object.fromEntries(envPairs.map((pair) => {
        const index = pair.indexOf('=');
        return [pair.slice(0, index), pair.slice(index + 1)];
      }));
      const result = await withChatClient((client) => registerConnector(client, {
        name, command: commandPath, params: commandArgs, env, timeoutMs: Math.max(timeoutMs, 30_000),
      }));
      if (json) output(result, true);
      else {
        console.log(`connector\t${result.connectorId}`);
        console.log(`status\t${result.status}`);
      }
      return;
    }
    if (subcommand === 'list') {
      const connectors = await withChatClient((client) => listConnectors(client));
      if (json) output(connectors, true);
      else {
        console.log('CONNECTOR ID\tENABLED\tNAME');
        for (const item of connectors) console.log(`${item.connectorId}\t${item.enabled ? 'yes' : 'no'}\t${item.name}`);
      }
      return;
    }
    if (subcommand === 'remove') {
      const id = operand;
      if (!/^\d{6,24}$/u.test(id || '')) throw new Error('connector id must contain 6 to 24 digits');
      const result = await withChatClient((client) => removeConnector(client, id));
      if (json) output(result, true);
      else console.log(`${result.removed ? 'removed' : 'removal unconfirmed'}\t${id}${result.removed ? '' : ` (${result.verificationError || result.disableError || result.disconnectError || 'connector still enabled'})`}`);
      if (!result.removed) process.exitCode = 1;
      return;
    }
    throw new Error(`unknown mcp command "${subcommand || ''}". Run "doubao help".`);
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
    const activeProfile = resolveProfile(dataDir, requestedProfile);
    const result = await selectModel(requestedModel, (await sessionIndex(activeProfile)).currentId, reasoning);
    if (json) output(result, true);
    else {
      console.log(`model\t${result.name}`);
      console.log(`changed\t${result.changed ? 'yes' : 'no'}`);
      if (result.reasoning) console.log(`reasoning\t${result.reasoning}`);
    }
    return;
  }

  if (command === 'model' && subcommand === 'reasoning') {
    const level = args.slice(2).join(' ');
    if (!level) throw new Error('model reasoning requires a level: low, medium, high, xhigh, max');
    const activeProfile = resolveProfile(dataDir, requestedProfile);
    const id = (await sessionIndex(activeProfile)).currentId;
    if (!id) throw new Error('current Doubao session was not found in the local session store');
    const result = await setConversationReasoning(id, level);
    if (json) output(result, true);
    else {
      console.log(`model\t${result.model}`);
      console.log(`reasoning\t${result.reasoning}`);
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
    const appPath = currentApp().appPath;
    const endpoint = new URL(existing.endpoint);
    if (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') {
      throw new Error('cdp launch only supports a localhost DOUBAO_CDP_ENDPOINT');
    }
    if (existing.identityMismatch) throw new Error(existing.error);
    if (!fs.existsSync(appPath)) throw new Error(`app not found: ${appPath}`);
    const port = endpoint.port || String(currentApp().port);
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
    const appPath = currentApp().appPath;
    const { sessions } = await sessionIndex(profile);
    const status = {
      installed: fs.existsSync(appPath),
      running: appRunning(appPath),
      appVersion: appVersion(appPath),
      app: currentApp().id,
      appPath,
      cdpEndpoint: currentApp().endpoint,
      dataDir,
      profile: { directory: profile.directory, name: profile.name },
      cachedSessions: sessions.length,
    };
    if (json) output(status, true);
    else {
      console.log(`app\t${currentApp().name}`);
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
    const result = await listDesktopSessions(profile, { limit, all, archived, timeoutMs });
    if (json) output(result, true);
    else printSessionList(result);
    if (all && !result.complete) process.exitCode = 1;
    return;
  }

  if (SESSION_ACTIONS.includes(subcommand)) {
    const input = sessionMutationInput(subcommand, operand, args.slice(3).join(' '));
    const result = await withChatClient(client => mutateApiSession(desktopListClient(client), input, timeoutMs));
    output({ platform: 'desktop', ...result }, json);
    return;
  }

  if (subcommand === 'current') {
    const { currentId: id, sessions } = await sessionIndex(profile);
    if (!id) throw new Error('current Doubao page is a draft or has no conversation; open a session first');
    const session = sessions.find(item => item.id === id) || { id, title: null };
    if (json) output(session, true);
    else console.log(`${session.id}\t${session.title || ''}`);
    return;
  }

  if (subcommand === 'create') {
    const message = args.slice(2).join(' ');
    const result = validateReplyOption(await createConversation(message, {
      mode: options.mode,
      attachments,
      model,
      reasoning,
      timeoutMs,
      waitForReply: wait,
      mcps,
      ...isolation,
    }), { expectJson, replySchema }, options.schema);
    if (result.status && result.status !== 'completed' && wait) process.exitCode = 1;
    if (json) output(result, true);
    else {
      if (result.runId) console.log(`run\t${result.runId} (${result.status})`);
      console.log(`created\t${result.conversationId || 'draft'}`);
      if (result.model) console.log(`model\t${result.model}`);
      if (result.reasoning) console.log(`reasoning\t${result.reasoning}`);
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

  if (subcommand === 'status' || subcommand === 'wait') {
    const id = validateId(operand);
    const result = subcommand === 'status' ? await taskStatus(id, { runId })
      : validateReplyOption(await waitConversation(id, { runId, timeoutMs }), { expectJson, replySchema }, options.schema);
    if (json) output(result, true);
    else {
      console.log(`${result.runId}\t${result.status}`);
      if (result.reply) console.log(result.reply.text);
      for (const item of result.pending || []) console.log(`pending\t${JSON.stringify(item)}`);
    }
    if (subcommand === 'wait' && result.status !== 'completed') process.exitCode = 1;
    return;
  }

  if (subcommand === 'stop') {
    const id = validateId(operand);
    const result = await stopConversation(id, { timeoutMs, runId });
    if (json) output(result, true);
    else console.log(`stopped\t${result.stopped ? 'yes' : `no (${result.reason || 'unknown'})`}`);
    if (!result.stopped) process.exitCode = 1;
    return;
  }

  if (subcommand === 'send') {
    const id = validateId(operand);
    const message = args.slice(3).join(' ');
    const result = validateReplyOption(await sendMessage(id, message, { attachments, waitForReply: wait, timeoutMs, model, reasoning, mcps, ...isolation }), { expectJson, replySchema }, options.schema);
    if (result.status && result.status !== 'completed' && wait) process.exitCode = 1;
    if (json) output(result, true);
    else {
      if (result.runId) console.log(`run\t${result.runId} (${result.status})`);
      console.log(`sent\t${result.sent.text}`);
      if (result.model) console.log(`model\t${result.model}`);
      if (result.reasoning) console.log(`reasoning\t${result.reasoning}`);
      for (const attachment of result.attachments || []) console.log(`attachment\t${attachment.name}`);
      if (result.reply) console.log(`reply\t${result.reply.text.replaceAll('\n', '\\n')}`);
    }
    return;
  }

  throw new Error(`unknown sessions command "${subcommand || ''}". Run "doubao help".`);
}

function printSessionList(result) {
  console.log('CONVERSATION ID\tRUNTIME\tTITLE');
  for (const session of result.sessions) console.log(`${session.id}\t${session.runtime}\t${session.title}`);
  console.log(`source\t${result.source}`);
  console.log(`complete\t${result.complete}`);
  console.log(`hasMore\t${result.hasMore}`);
}
