import fs from 'node:fs';
import { validateScheduledTaskCreate, validateScheduledTaskPatch } from './scheduled-tasks.mjs';
import { SESSION_ACTIONS, sessionMutationInput } from './session-actions.mjs';
import { projectCreationInput, validateTaskOptions } from './context.mjs';
import { validateHeadlessOptions } from './headless.mjs';
import { validateOptionContract } from './options-contract.mjs';

export function validateCliOptions(options, explicitOptions) {
  const { args, mode, inputFile, workspace, unknownFlags, attachments, model, reasoning, wait, noSkills, commandPath, commandArgs, envPairs, runtime, mcps, permission, project, enterpriseKnowledge, expectJson, replySchema, cookieFile, runId } = options;
  const selectedPlatform = options.platform || options.app || (process.platform === 'linux' ? 'headless' : undefined);
  const backend = selectedPlatform === 'headless' ? 'headless' : 'desktop';
  validateOptionContract({ ...options, explicitOptions: [...explicitOptions] }, backend);
  if (args[0] === 'sessions' && SESSION_ACTIONS.includes(args[1])) sessionMutationInput(args[1], args[2], args.slice(3).join(' '));
  if (mode && backend === 'desktop' && mode !== 'goal') throw new Error('--mode requires goal on Desktop; chat/work require Web or Headless sessions create');
  if (mode === 'goal' && !args.slice(2).join(' ').trim()) throw new Error('--mode goal requires a message');
  if (args[0] === 'automations' && ['create', 'update'].includes(args[1])) {
    if (!inputFile) throw new Error('automations create/update requires --file <json-path>');
    let input;
    try { input = JSON.parse(fs.readFileSync(inputFile, 'utf8')); }
    catch (error) { throw new Error(`Cannot read automation JSON: ${error.message}`); }
    options.automationInput = args[1] === 'create' ? validateScheduledTaskCreate(input) : validateScheduledTaskPatch(input);
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
    if (args[0] !== 'sessions' || !['create', 'send'].includes(args[1]) || (backend !== 'headless' && !mcps.length && runtime !== 'local')) {
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
    if (backend !== 'headless' && attachments.length) throw new Error('--mcp is not supported with attachments');
    if (backend !== 'headless' && !wait) throw new Error('--mcp requires --wait so the local tool session stays connected');
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
  if (cookieFile && (selectedPlatform !== 'headless' || args[0] !== 'login')) throw new Error('--cookie-file requires doubao headless login');
  if (selectedPlatform === 'headless') validateHeadlessOptions(options);
  return options;
}
