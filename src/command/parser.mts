import { Command, Option } from 'commander';
import { helpCommandPath } from './help.mjs';
import { optionDefinitions, type CliOptions } from './options.mjs';

interface ParsedValues {
  help: boolean; json: boolean; archived: boolean; all: boolean; yes: boolean; wait: boolean;
  run?: string; app?: string; platform?: string; target?: string; file?: string;
  mode?: string; cookieFile?: string; profile?: string; timeout: number; limit: number;
  model?: string; reasoning?: string; attach: string[]; runtime?: string; project?: string;
  enterpriseKnowledge: boolean; workspace?: string; skills: boolean; permission?: string;
  expectJson: boolean; replySchema?: string; mcp: string[]; command?: string; arg: string[]; env: string[];
}

export function parseArguments(argv: string[], validatePermission: (value: string) => unknown): { options: CliOptions; explicitOptions: Set<string> } {
  const command = new Command('doubao').helpOption(false).addHelpCommand(false)
    .allowExcessArguments(true).exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const values: (string | undefined)[] = [];
  const flags = new Map<string, Option>();
  for (const definition of optionDefinitions) {
    const option = new Option(definition.flags, definition.description);
    option.default(definition.defaultValue ?? (definition.collect ? [] : option.negate ? true : option.required ? undefined : false));
    if (definition.parse) option.argParser((encoded: string, previous: unknown) => {
      const value = definition.parse!(values[Number(encoded)]);
      if (option.long === '--permission') validatePermission(String(value));
      return definition.collect ? [...(previous as string[]), value] : value;
    });
    command.addOption(option);
    if (option.long) flags.set(option.long, option);
    if (option.short) flags.set(option.short, option);
  }

  // Preserve the public token grammar: exact option spellings only, one value per
  // occurrence (even '--help' as an MCP argument), and literal text after '--'.
  // Encoding protects those operands from Commander's short-option/equals syntax.
  const normalized: string[] = [];
  const operands: string[] = [];
  const explicitOptions = new Set<string>();
  const unknownFlags: string[] = [];
  let literalOperandStart: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (literalOperandStart === undefined && token === '--') {
      literalOperandStart = operands.length;
      continue;
    }
    const option = literalOperandStart === undefined ? flags.get(token) : undefined;
    if (literalOperandStart === undefined && token.startsWith('-')) explicitOptions.add(token);
    if (option) {
      if (option.required) {
        values.push(argv[++index]);
        normalized.push(`${option.long}=${values.length - 1}`);
      } else normalized.push(token);
    } else {
      if (literalOperandStart === undefined && token.startsWith('-')) unknownFlags.push(token);
      normalized.push(`operand:${operands.length}`);
      operands.push(token);
    }
  }
  command.parse(normalized, { from: 'user' });
  const parsed = command.opts<ParsedValues>();
  const args: string[] = [];
  let namespace: 'web' | 'headless' | undefined;
  let literalStart: number | undefined;
  for (const encoded of command.args) {
    const index = Number(encoded.slice('operand:'.length));
    const token = operands[index];
    const literal = literalOperandStart !== undefined && index >= literalOperandStart;
    if (literal && literalStart === undefined) literalStart = args.length;
    if (!literal && !namespace && (!args.length || args.length === 1 && args[0] === 'help') && (token === 'web' || token === 'headless')) namespace = token;
    else args.push(token);
  }
  if (literalOperandStart !== undefined && literalStart === undefined) literalStart = args.length;
  let platform = parsed.platform === 'web' ? 'headless' : parsed.platform;
  const app = parsed.app;
  if (namespace) {
    if (platform && platform !== 'headless') throw new Error(`doubao ${namespace} conflicts with --platform ${platform}`);
    if (app) throw new Error(`doubao ${namespace} conflicts with --app ${app}`);
    platform = 'headless';
  }
  if (app && platform && app !== platform) throw new Error('--app and --platform select different backends');
  const options: CliOptions = {
    args, app, platform, targetId: parsed.target, mode: parsed.mode, inputFile: parsed.file,
    cookieFile: parsed.cookieFile, profile: parsed.profile, runId: parsed.run,
    json: parsed.json, yes: parsed.yes, wait: parsed.wait, timeoutMs: parsed.timeout * 1000,
    limit: parsed.limit, all: parsed.all, archived: parsed.archived, model: parsed.model,
    reasoning: parsed.reasoning, attachments: parsed.attach, workspace: parsed.workspace,
    noSkills: !parsed.skills, permission: parsed.permission, runtime: parsed.runtime,
    project: parsed.project, enterpriseKnowledge: parsed.enterpriseKnowledge,
    expectJson: parsed.expectJson, replySchema: parsed.replySchema, mcps: parsed.mcp,
    commandPath: parsed.command, commandArgs: parsed.arg, envPairs: parsed.env, unknownFlags,
  };
  const helpPlatform = platform || app || (process.platform === 'linux' ? 'headless' : undefined);
  const positionalArgs = args.slice(0, literalStart ?? args.length);
  const helpIndex = positionalArgs.indexOf('help');
  if (helpIndex === 0 || helpIndex === 1 || helpIndex === 2 && positionalArgs.length === 3 && literalStart === undefined) {
    const topic = positionalArgs.filter((_, index) => index !== helpIndex);
    const helpPath = helpCommandPath(topic, helpPlatform);
    if (helpIndex <= helpPath.length) options.helpPath = helpPath;
  }
  if (!options.helpPath && parsed.help) options.helpPath = helpCommandPath(positionalArgs, helpPlatform);
  if (!options.helpPath && !positionalArgs.length && ['help', '--help', '-h'].includes(args[0])) options.helpPath = [];
  return { options, explicitOptions };
}
