import fs from 'node:fs';
import { readUsage, formatUsage } from './usage.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { getDataDir, readProfiles, resolveProfile } from './storage.mjs';
import { sessionIndex } from './sessions.mjs';
import { cdpStatus, withChatClient } from './cdp.mjs';
import { listConnectors, registerConnector, removeConnector } from './mcp.mjs';
import { createConversation, openConversation, readConversation, sendMessage, setConversationReasoning, stopConversation, taskStatus, waitConversation } from './automation.mjs';
import { currentModel, listModels, selectModel } from './models.mjs';
import {
  checkForUpdate,
  installUpdate,
  maybeAutoUpdate,
  maybeUpdateReminder,
  readUpdateState,
  setAutoUpdate,
  updateStatePath,
} from './update.mjs';
import { validateReply, validateSchema } from './validate.mjs';
import { resolvePermission } from './permissions.mjs';
import { createProject, listProjects, projectCreationInput, runtimeAvailability, validateTaskOptions } from './context.mjs';
import { currentApp, resolvePlatform, withApp } from './app.mjs';
import { executeWeb, validateWebOptions } from './web.mjs';
import { executeHeadless, validateHeadlessOptions } from './headless.mjs';
const CLI_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `Usage:
  doubao status [--profile <name>] [--json]
  doubao usage [--profile <name>] [--json]
  doubao profiles [--json]
  doubao runtimes [--json]
  doubao projects list [--json]
  doubao projects create <name> [--workspace <path>] [--json]
  doubao sessions list [--profile <name>] [--json]
  doubao sessions current [--profile <name>] [--json]
  doubao sessions create [message] [--attach <path>] [--model <model>] [--reasoning <level>] [--wait] [--timeout <seconds>] [--runtime local|cloud] [--project <id-or-name|none>] [--enterprise-knowledge] [--workspace <path>] [--no-skills] [--mcp <connector-id>]... [--permission <mode>] [--expect-json] [--reply-schema <path>] [--json]
  doubao sessions open <conversation-id>
  doubao sessions read <conversation-id> [--limit <count>] [--json]
  doubao sessions send <conversation-id> <message> [--attach <path>] [--model <model>] [--reasoning <level>] [--wait] [--timeout <seconds>] [--runtime local|cloud] [--project <id-or-name|none>] [--enterprise-knowledge] [--workspace <path>] [--no-skills] [--mcp <connector-id>]... [--permission <mode>] [--expect-json] [--reply-schema <path>] [--json]
  doubao sessions status <conversation-id> [--run <run-id>] [--json]
  doubao sessions wait <conversation-id> [--run <run-id>] [--timeout <seconds>] [--expect-json] [--reply-schema <path>] [--json]
  doubao sessions stop <conversation-id> [--run <run-id>] [--json]
  doubao mcp register <name> --command <path> [--arg <x>]... [--env K=V]... [--json]
  doubao mcp list [--json]
  doubao mcp remove <connector-id> [--json]
  doubao models [--json]
  doubao model [--json]
  doubao model current [--json]
  doubao model select <model> [--reasoning <level>] [--json]
  doubao model reasoning <level> [--json]
  doubao cdp status [--json]
  doubao cdp launch [--yes] [--json]
  doubao update [--json]
  doubao update check [--json]
  doubao update auto <on|off|status> [--json]
  doubao capabilities [--json]
  doubao web <command> [options]  Web commands; run "doubao web help"
  doubao headless <command> [options]  Headless cloud commands; run "doubao headless help"

Help:
  Add --help or -h to any command, or use help <command>.
  --  Treat the remaining arguments as literal text, including help and --help.

Local task execution permission (requires --runtime local or --mcp):
  --permission <mode>  AlwaysAsk | AskOnRisk | FullAccess (default)
                      Repeat on each turn; approval is handled by Doubao.
                      This does not guarantee approval for each MCP call.

Application:
  --app work|doubao  Select an app (default: Work if installed, otherwise Doubao)
  --platform work|doubao|web|headless  Select a backend; web and headless namespaces are compatibility aliases
  --target <id>  Select a Doubao web CDP page when several tabs match
  --mode chat|work  Select the mode for a new web or headless conversation

Environment:
  DOUBAO_APP       Override the application path
  DOUBAO_DATA_DIR  Override the Doubao user-data directory
  DOUBAO_CDP_ENDPOINT  CDP endpoint (Work: 9226; Doubao: 9225; Web: 9227)
  DOUBAO_BROWSER_APP  Web browser app path (default: Google Chrome.app)
  DOUBAO_WEB_PROFILE_DIR  Dedicated browser data directory for web launch
  DOUBAO_CLI_CONFIG_DIR  Override the doubao-cli settings directory
  DOUBAO_CLI_DISABLE_AUTO_UPDATE  Set to 1 to skip configured automatic updates
`;

const HEADLESS_HELP = `Usage:
  doubao headless login [--cookie-file <path>] [--timeout <seconds>] [--json]
  doubao headless logout [--json]
  doubao headless status [--json]
  doubao headless capabilities [--json]
  doubao headless sessions list [--limit <count>] [--json]
  doubao headless sessions read <conversation-id> [--limit <count>] [--json]
  doubao headless sessions create <message> [--mode chat|work] [--model <id-or-name>] [--wait] [--timeout <seconds>] [--json]
  doubao headless sessions send <conversation-id> <message> [--model <id-or-name>] [--wait] [--timeout <seconds>] [--json]
  doubao headless sessions status <conversation-id> [--run <run-id>] [--json]
  doubao headless sessions wait <conversation-id> [--run <run-id>] [--timeout <seconds>] [--json]
  doubao headless sessions stop <conversation-id> [--run <run-id>] [--timeout <seconds>] [--json]
  doubao headless models [--json]
  doubao headless update [--json]
  doubao headless update check [--json]
  doubao headless update auto <on|off|status> [--json]

Help:
  Add --help or -h to any command, or use help <command>.
  --  Treat the remaining arguments as literal text, including help and --help.

Options:
  --mode chat|work  Select the mode for a new conversation
  --model <id-or-name>  Select an available model from headless models
  --runtime cloud  Work conversations only (default)
  --timeout <seconds>  Request or wait budget (default: 120)
  --expect-json / --reply-schema <path>  Validate the final reply; create/send require --wait
  --json  Output results as JSON
  --  Treat the remaining arguments as message text

Account:
  Account login is required. Run "doubao headless login" and scan the terminal QR code with the Doubao mobile app.
  --cookie-file imports session cookies for unattended setup; cookie files are secrets. No installed browser or local Doubao app is required.
  Cloud Work is supported; local task execution is unsupported.
  DOUBAO_HEADLESS_COOKIE supplies an existing session without saving it.

Compatibility:
  doubao --platform headless <command> remains supported.
  Run "doubao help" for desktop and update commands.
`;

const WEB_HELP = `Usage:
  doubao web login [--timeout <seconds>] [--json]
  doubao web status [--json]
  doubao web capabilities [--json]
  doubao web sessions list [--json]
  doubao web sessions current [--json]
  doubao web sessions open <conversation-id> [--json]
  doubao web sessions read <conversation-id> [--limit <count>] [--json]
  doubao web sessions create [message] [--mode chat|work] [--runtime cloud] [--wait] [--json]
  doubao web sessions send <conversation-id> <message> [--runtime cloud] [--wait] [--json]
  doubao web sessions status <conversation-id> [--run <run-id>] [--json]
  doubao web sessions wait <conversation-id> [--run <run-id>] [--timeout <seconds>] [--expect-json] [--reply-schema <path>] [--json]
  doubao web sessions stop <conversation-id> [--run <run-id>] [--timeout <seconds>] [--json]
  doubao web cdp status [--json]
  doubao web cdp launch [--json]
  doubao web update [--json]
  doubao web update check [--json]
  doubao web update auto <on|off|status> [--json]
  doubao web --version

Help:
  Add --help or -h to any command, or use help <command>.
  --  Treat the remaining arguments as literal text, including help and --help.

Options:
  --target <id>  Select a browser page when several Doubao tabs match
  --mode chat|work  Select the mode for a new conversation
  --runtime cloud  Work conversations only; local execution is unsupported
  --timeout <seconds>  Request or wait budget (default: 120)
  --expect-json / --reply-schema <path>  Validate the final reply; create/send require --wait
  --  Treat the remaining arguments as message text

Browser:
  Run "doubao web login" once, then complete sign-in in the opened browser.
  It starts or reuses the browser and waits for login (default: 120 seconds).
  Uses the signed-in dedicated browser; credentials are not copied.
  The browser connection is managed internally (default: http://127.0.0.1:9227).
  DOUBAO_CDP_ENDPOINT, DOUBAO_BROWSER_APP and DOUBAO_WEB_PROFILE_DIR configure it.
  Attachments, model selection and desktop task settings are unsupported.

Compatibility:
  doubao --platform web <command> remains supported.
  doubao web cdp status / cdp launch remain available for advanced setup.
  Run "doubao help" for desktop and update commands.
`;

function helpEntries(platform) {
  const web = platform === 'web';
  const headless = platform === 'headless';
  const prefix = web ? '  doubao web ' : headless ? '  doubao headless ' : '  doubao ';
  const helpText = web ? WEB_HELP : headless ? HEADLESS_HELP : HELP;
  return helpText.split('\n\n')[0].split('\n').slice(1)
    .filter(line => line.startsWith(prefix) && (web || headless || !line.startsWith('  doubao web ') && !line.startsWith('  doubao headless ')))
    .map(line => {
      const tokens = line.slice(prefix.length).split(' ');
      const end = tokens.findIndex(token => ['<', '[', '-'].some(prefix => token.startsWith(prefix)));
      return { line, path: tokens.slice(0, end < 0 ? tokens.length : end) };
    }).filter(entry => entry.path.length);
}

function helpCommandPath(args, platform) {
  if (!args.length) return [];
  if (['version', '--version', '-v'].includes(args[0])) return ['version'];
  const entries = helpEntries(platform);
  const matches = entries.filter(entry => entry.path[0] === args[0]);
  if (!matches.length) throw new Error(`Unknown help topic: ${args.join(' ')}`);
  if (args.length > 1 && matches.some(entry => entry.path.length > 1)) {
    if (!matches.some(entry => entry.path[1] === args[1])) throw new Error(`Unknown help topic: ${args.slice(0, 2).join(' ')}`);
    return args.slice(0, 2);
  }
  return args.slice(0, 1);
}

function commandHelp(helpPath, platform) {
  const web = platform === 'web';
  const headless = platform === 'headless';
  if (!helpPath.length) return web ? WEB_HELP : headless ? HEADLESS_HELP : HELP;
  const lines = helpPath[0] === 'version'
    ? [`  doubao${web ? ' web' : headless ? ' headless' : ''} --version`]
    : helpEntries(platform).filter(entry => helpPath.every((token, index) => entry.path[index] === token)).map(entry => entry.line);
  const options = web
    ? '  --target <id>  Select a browser page\n  --json  Output results as JSON'
    : headless
      ? '  --mode chat|work  Select the mode for a new conversation\n  --timeout <seconds>  Request or wait budget\n  --json  Output results as JSON'
    : '  --app work|doubao  Select the desktop app\n  --platform work|doubao|web  Select a backend\n  --profile <name>  Select a desktop profile\n  --json  Output results as JSON';
  const permission = !web && !headless && helpPath[0] === 'sessions' && (!helpPath[1] || ['create', 'send'].includes(helpPath[1]))
    ? `\n\nLocal task execution permission${HELP.split('\n\nLocal task execution permission')[1].split('\n\nApplication:')[0]}`
    : '';
  return `Usage:\n${lines.join('\n')}\n\nOptions:\n${options}\n  -h, --help  Show help without executing the command\n  --  Treat the remaining arguments as literal text${permission}\n`;
}

export function parseOptions(argv) {
  const args = [];
  const unknownFlags = [];
  let help = false;
  let literalStart;
  let profile;
  let runId;
  let app;
  let platform;
  let webNamespace = false;
  let headlessNamespace = false;
  let targetId;
  let mode;
  let cookieFile;
  let json = false;
  let yes = false;
  let wait = false;
  let timeoutSeconds = 120;
  let limit = 20;
  let model;
  let reasoning;
  let workspace;
  let permission;
  let runtime;
  let project;
  let enterpriseKnowledge = false;
  let noSkills = false;
  let expectJson = false;
  let replySchema;
  const mcps = [];
  let commandPath;
  const commandArgs = [];
  const envPairs = [];
  const attachments = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--') {
      literalStart = args.length;
      args.push(...argv.slice(index + 1));
      break;
    } else if (argv[index] === '--help' || argv[index] === '-h') {
      help = true;
    } else if (argv[index] === '--json') {
      json = true;
    } else if (argv[index] === '--yes') {
      yes = true;
    } else if (argv[index] === '--wait') {
      wait = true;
    } else if (argv[index] === '--run') {
      runId = argv[++index];
      if (!/^\d{12,24}$/u.test(runId || '')) throw new Error('--run requires a numeric run id');
    } else if (argv[index] === '--app') {
      app = argv[++index];
      if (!['work', 'doubao'].includes(app)) throw new Error('--app requires work or doubao');
    } else if (argv[index] === '--platform') {
      platform = argv[++index];
      if (!['work', 'doubao', 'web', 'headless'].includes(platform)) throw new Error('--platform requires work, doubao, web, or headless');
    } else if (argv[index] === '--target') {
      targetId = argv[++index];
      if (!targetId || targetId.startsWith('-')) throw new Error('--target requires a CDP target id');
    } else if (argv[index] === '--mode') {
      mode = argv[++index];
      if (!['chat', 'work'].includes(mode)) throw new Error('--mode requires chat or work');
    } else if (argv[index] === '--cookie-file') {
      cookieFile = argv[index + 1];
      if (!cookieFile || cookieFile.startsWith('--')) throw new Error('--cookie-file requires a file path');
      index += 1;
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
    } else if (argv[index] === '--reasoning') {
      reasoning = argv[index + 1];
      if (!reasoning) throw new Error('--reasoning requires a value');
      index += 1;
    } else if (argv[index] === '--attach') {
      const attachment = argv[index + 1];
      if (!attachment || attachment.startsWith('--')) throw new Error('--attach requires a file path');
      attachments.push(attachment);
      index += 1;
    } else if (argv[index] === '--runtime') {
      runtime = argv[++index];
      if (!['local', 'cloud'].includes(runtime)) throw new Error('--runtime requires local or cloud');
    } else if (argv[index] === '--project') {
      project = argv[++index];
      if (!project?.trim() || project.startsWith('--')) throw new Error('--project requires a project id or exact name (none to clear)');
    } else if (argv[index] === '--enterprise-knowledge') {
      enterpriseKnowledge = true;
    } else if (argv[index] === '--workspace') {
      workspace = argv[index + 1];
      if (!workspace || workspace.startsWith('--')) throw new Error('--workspace requires a directory path');
      index += 1;
    } else if (argv[index] === '--no-skills') {
      noSkills = true;
    } else if (argv[index] === '--permission') {
      permission = argv[index + 1];
      if (!permission || permission.startsWith('--')) throw new Error('--permission requires a mode: AlwaysAsk, AskOnRisk, or FullAccess');
      resolvePermission(permission);
      index += 1;
    } else if (argv[index] === '--expect-json') {
      expectJson = true;
    } else if (argv[index] === '--reply-schema') {
      replySchema = argv[index + 1];
      if (!replySchema || replySchema.startsWith('--')) throw new Error('--reply-schema requires a JSON schema file path');
      index += 1;
    } else if (argv[index] === '--mcp') {
      const connectorId = argv[index + 1];
      if (!/^\d{6,24}$/u.test(connectorId || '')) throw new Error('--mcp requires a numeric connector id');
      mcps.push(connectorId);
      index += 1;
    } else if (argv[index] === '--command') {
      commandPath = argv[index + 1];
      if (!commandPath || commandPath.startsWith('--')) throw new Error('--command requires an executable path');
      index += 1;
    } else if (argv[index] === '--arg') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--arg requires a value');
      commandArgs.push(value);
      index += 1;
    } else if (argv[index] === '--env') {
      const pair = argv[index + 1];
      if (!pair || !pair.includes('=')) throw new Error('--env requires a KEY=VALUE pair');
      envPairs.push(pair);
      index += 1;
    } else if ((!args.length || args.length === 1 && args[0] === 'help') && !webNamespace && !headlessNamespace && ['web', 'headless'].includes(argv[index])) {
      webNamespace = argv[index] === 'web';
      headlessNamespace = argv[index] === 'headless';
    } else {
      args.push(argv[index]);
      if (argv[index].startsWith('-')) unknownFlags.push(argv[index]);
    }
  }
  if (webNamespace) {
    if (platform && platform !== 'web') throw new Error(`doubao web conflicts with --platform ${platform}`);
    if (app) throw new Error(`doubao web conflicts with --app ${app}`);
    platform = 'web';
  }
  if (headlessNamespace) {
    if (platform && platform !== 'headless') throw new Error(`doubao headless conflicts with --platform ${platform}`);
    if (app) throw new Error(`doubao headless conflicts with --app ${app}`);
    platform = 'headless';
  }
  if (app && platform && app !== platform) throw new Error('--app and --platform select different backends');
  const options = { args, app, platform, targetId, mode, cookieFile, profile, runId, json, yes, wait, timeoutMs: timeoutSeconds * 1000, limit, model, reasoning, attachments, workspace, noSkills, permission, runtime, project, enterpriseKnowledge, expectJson, replySchema, mcps, commandPath, commandArgs, envPairs, unknownFlags };
  const selectedPlatform = platform || app || (process.platform === 'linux' ? 'headless' : undefined);
  const helpPlatform = selectedPlatform;
  const positionalArgs = args.slice(0, literalStart ?? args.length);
  const helpIndex = positionalArgs.indexOf('help');
  // Reserve standalone help along command paths; -- preserves literal operands.
  if (helpIndex === 0 || helpIndex === 1 || helpIndex === 2 && positionalArgs.length === 3 && literalStart === undefined) {
    const topic = positionalArgs.filter((_, index) => index !== helpIndex);
    const helpPath = helpCommandPath(topic, helpPlatform);
    if (helpIndex <= helpPath.length) return { ...options, helpPath };
  }
  if (help) return { ...options, helpPath: helpCommandPath(positionalArgs, helpPlatform) };
  if (!positionalArgs.length && ['help', '--help', '-h'].includes(args[0])) return { ...options, helpPath: [] };
  const unknownWebFlags = unknownFlags.filter(flag => flag !== args[0] || !['--help', '-h', '--version', '-v'].includes(flag));
  if (selectedPlatform === 'web' && unknownWebFlags.length) throw new Error(`Unknown Web option: ${unknownWebFlags[0]}; use -- before literal option text`);
  if (selectedPlatform === 'headless' && unknownWebFlags.length) throw new Error(`Unknown headless option: ${unknownWebFlags[0]}; use -- before literal message text`);
  if (targetId && !['web', 'headless'].includes(selectedPlatform)) throw new Error('--target requires doubao web (or --platform web)');
  if (mode && !((selectedPlatform === 'web' || selectedPlatform === 'headless') && args[0] === 'sessions' && args[1] === 'create')) {
    throw new Error('--mode requires doubao web sessions create or doubao headless sessions create (or a matching --platform selector)');
  }
  if (runId && (args[0] !== 'sessions' || !['status', 'wait', 'stop'].includes(args[1]))) throw new Error('--run requires sessions status/wait/stop');
  if (args[0] === 'projects' && args[1] === 'create') {
    if (unknownFlags.length) throw new Error(`Unknown projects create option: ${unknownFlags[0]}. Run "doubao help"; use -- before a name starting with -`);
    projectCreationInput(args.slice(2).join(' '), workspace);
    if (attachments.length || model || reasoning || wait || noSkills || commandPath || commandArgs.length || envPairs.length) {
      throw new Error('projects create accepts a name and optional --workspace, --app, --profile, --json');
    }
  }
  validateTaskOptions({ runtime, mcps, workspace, permission, noSkills });
  if (runtime !== undefined || project !== undefined || enterpriseKnowledge) {
    if (args[0] !== 'sessions' || !['create', 'send'].includes(args[1])) throw new Error('Task context options require sessions create/send');
    if (!args.slice(args[1] === 'create' ? 2 : 3).join(' ').trim()) throw new Error('Task context options require a message');
  }
  if (permission !== undefined) {
    if (args[0] !== 'sessions' || !['create', 'send'].includes(args[1]) || (!mcps.length && runtime !== 'local')) {
      throw new Error('--permission requires sessions create/send with --runtime local or --mcp');
    }
    if (!args.slice(args[1] === 'create' ? 2 : 3).join(' ').trim()) {
      throw new Error('--permission requires a message');
    }
  }
  if (mcps.length) {
    if (args[0] !== 'sessions' || !['create', 'send'].includes(args[1])) {
      throw new Error('--mcp requires sessions create/send');
    }
    if (!args.slice(args[1] === 'create' ? 2 : 3).join(' ').trim()) throw new Error('--mcp requires a message');
    if (attachments.length) throw new Error('--mcp is not supported with attachments');
    if (!wait) throw new Error('--mcp requires --wait so the local tool session stays connected');
  }
  if (expectJson || replySchema) {
    if (args[0] !== 'sessions' || !['create', 'send', 'wait'].includes(args[1])) {
      throw new Error('--expect-json and --reply-schema require sessions create/send/wait');
    }
    if (!wait && args[1] !== 'wait') throw new Error('--expect-json and --reply-schema require --wait');
    if (args[1] !== 'wait' && !args.slice(args[1] === 'create' ? 2 : 3).join(' ').trim()) {
      throw new Error('--expect-json and --reply-schema require a message');
    }
  }
  if (selectedPlatform === 'web') validateWebOptions(options);
  if (cookieFile && (selectedPlatform !== 'headless' || args[0] !== 'login')) throw new Error('--cookie-file requires doubao headless login');
  if (selectedPlatform === 'headless') validateHeadlessOptions(options);
  return options;
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
  } else if (result.skipped === 'not-enabled' && !json) {
    const reminder = await maybeUpdateReminder(CLI_VERSION);
    if (reminder) {
      console.error(`doubao: update available: ${reminder.latestVersion} (current ${reminder.currentVersion}); run "doubao update" to upgrade or "doubao update auto on" to enable automatic updates`);
    }
  }
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
    console.log(commandHelp(options.helpPath, helpPlatform));
    return;
  }
  options.schema = loadReplySchema(options);
  const selectedPlatform = options.platform || options.app || (process.platform === 'linux' ? 'headless' : undefined);
  const app = resolvePlatform(selectedPlatform);
  if (options.targetId) app.targetId = options.targetId;
  if (options.profile && !['web', 'headless'].includes(app.id)) {
    app.profile = resolveProfile(app.dataDir, options.profile).directory;
    const [command, subcommand] = options.args;
    const usesRenderer = ['models', 'model', 'mcp', 'runtimes', 'projects', 'usage'].includes(command)
      || (command === 'sessions' && ['open', 'create', 'send', 'read', 'stop', 'status', 'wait'].includes(subcommand));
    if (usesRenderer && app.profile !== readProfiles(app.dataDir).lastUsed) {
      throw new Error(`Profile ${app.profile} is not active in ${app.name}; switch profiles in the app before automating it`);
    }
  }
  return withApp(app, async () => {
    try { return await run(options); }
    catch (error) {
      if (!error.result) throw error;
      if (app.id === 'web' && options.args[0] === 'login' && !options.json) console.error(`doubao: ${error.message}`);
      else output({ ...error.result, error: error.code || 'task_error', message: error.message }, options.json);
      process.exitCode = 1;
    }
  });
}

async function run(options) {
  const { args, profile: requestedProfile, runId, json, yes, wait, timeoutMs, limit, model, reasoning, attachments, workspace, noSkills, permission, runtime, project, enterpriseKnowledge, expectJson, replySchema, mcps, commandPath, commandArgs, envPairs } = options;
  const isolation = { runtime, project, enterpriseKnowledge, workspace, skillPaths: noSkills ? [] : undefined, permission };
  const [command, subcommand, operand] = args;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(currentApp().id === 'web' ? WEB_HELP : currentApp().id === 'headless' ? HEADLESS_HELP : HELP);
    return;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(CLI_VERSION);
    return;
  }

  if (command === 'update') {
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
    if (json) output(result, true);
    else if (result.updated) console.log(`updated\t${result.latestVersion}`);
    else console.log(`up to date\t${result.currentVersion}`);
    return;
  }

  await runConfiguredAutoUpdate(command, json);

  if (currentApp().id === 'web') {
    const result = await executeWeb(options);
    const validated = validateReplyOption(result, { expectJson, replySchema }, options.schema);
    if ((wait || command === 'sessions' && subcommand === 'wait') && validated.status && validated.status !== 'completed') process.exitCode = 1;
    if (command === 'cdp' && subcommand === 'status' && !validated.available) process.exitCode = 1;
    if (command === 'sessions' && subcommand === 'stop' && validated.stopped === false) process.exitCode = 1;
    output(command === 'login' && !json ? 'Doubao Web is signed in and ready.' : validated, json);
    return;
  }

  if (currentApp().id === 'headless') {
    const result = await executeHeadless(options);
    const validated = validateReplyOption(result, { expectJson, replySchema }, options.schema);
    if ((wait || command === 'sessions' && subcommand === 'wait') && validated.status && validated.status !== 'completed') process.exitCode = 1;
    if (command === 'sessions' && subcommand === 'stop' && validated.stopped === false) process.exitCode = 1;
    output(command === 'login' && !json ? 'Doubao Headless is signed in and ready.' : validated, json);
    return;
  }

  const dataDir = getDataDir();

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
    const result = await withChatClient(listProjects);
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
    const { sessions } = await sessionIndex(profile);
    if (json) output(sessions, true);
    else {
      console.log('CONVERSATION ID\tTITLE');
      for (const session of sessions) console.log(`${session.id}\t${session.title}`);
    }
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
