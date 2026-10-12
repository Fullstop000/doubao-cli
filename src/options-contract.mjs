const SESSION_CREATE_OR_SEND = command => command[0] === 'sessions' && ['create', 'send'].includes(command[1]);
const SESSION_STATE = command => command[0] === 'sessions' && ['status', 'wait', 'stop'].includes(command[1]);
const SESSION_LIST_OR_READ = (command, backend) => command[0] === 'sessions'
  && (command[1] === 'read' || backend === 'headless' && command[1] === 'list');

function allowed(flag, command, backend) {
  const sessionMessage = SESSION_CREATE_OR_SEND(command);
  const sessionState = SESSION_STATE(command);
  switch (flag) {
    case '--yes': return backend === 'desktop' && command[0] === 'cdp' && command[1] === 'launch';
    case '--limit': return SESSION_LIST_OR_READ(command, backend);
    case '--run': return sessionState;
    case '--mode': return ['web', 'headless'].includes(backend) && command[0] === 'sessions' && command[1] === 'create';
    case '--timeout':
      if (backend === 'headless') return ['login', 'status', 'models', 'profiles', 'usage', 'runtimes'].includes(command[0])
        || command[0] === 'sessions' || command[0] === 'projects' && ['list', 'create'].includes(command[1])
        || command[0] === 'model' && (!command[1] || ['current', 'select', 'reasoning'].includes(command[1]))
        || command[0] === 'mcp' && ['register', 'list', 'remove'].includes(command[1]);
      if (backend === 'web') return command[0] === 'login' || command[0] === 'sessions'
        && ['open', 'read', 'create', 'send', 'status', 'wait', 'stop'].includes(command[1]);
      return sessionMessage || command[0] === 'sessions' && ['read', 'wait', 'stop'].includes(command[1])
        || command[0] === 'mcp' && command[1] === 'register';
    case '--target': return backend === 'web' && ['login', 'status', 'cdp', 'sessions'].includes(command[0]);
    case '--profile':
      if (backend === 'web') return false;
      if (backend === 'headless') return ['login', 'logout', 'status', 'models', 'usage', 'runtimes', 'projects', 'model', 'mcp', 'sessions'].includes(command[0]);
      return ['status', 'usage', 'runtimes', 'projects', 'sessions', 'mcp', 'models', 'model'].includes(command[0]);
    case '--cookie-file': return backend === 'headless' && command[0] === 'login';
    case '--model': return ['desktop', 'headless'].includes(backend) && sessionMessage;
    case '--reasoning': return ['desktop', 'headless'].includes(backend) && (sessionMessage
      || ['desktop', 'headless'].includes(backend) && command[0] === 'model' && command[1] === 'select');
    case '--attach': return ['desktop', 'headless'].includes(backend) && sessionMessage;
    case '--runtime': return sessionMessage;
    case '--project': case '--enterprise-knowledge': case '--workspace': case '--no-skills':
    case '--permission':
      return ['desktop', 'headless'].includes(backend) && (sessionMessage || flag === '--workspace'
        && ['desktop', 'headless'].includes(backend) && command[0] === 'projects' && command[1] === 'create');
    case '--mcp': return true; // Existing MCP validation preserves permission and wait error ordering.
    case '--expect-json': case '--reply-schema':
      return command[0] === 'sessions' && ['create', 'send', 'wait'].includes(command[1]);
    case '--wait': return sessionMessage;
    case '--command': case '--arg': case '--env': return ['desktop', 'headless'].includes(backend) && command[0] === 'mcp' && command[1] === 'register';
    default: return true;
  }
}

const HEADLESS_HELP_OPTIONS = [
  ['--profile', '<name>', 'Select an independent Headless account profile', command => ['login', 'logout', 'status', 'models', 'usage', 'runtimes', 'projects', 'model', 'mcp', 'sessions'].includes(command[0])],
  ['--cookie-file', '<path>', 'Import cookies from a session file during login', command => command[0] === 'login'],
  ['--timeout', '<seconds>', 'Set the request or wait budget', command => allowed('--timeout', command, 'headless')],
  ['--limit', '<count>', 'Limit the number of listed sessions', command => allowed('--limit', command, 'headless')],
  ['--mode', 'chat|work', 'Select the mode for a new conversation', command => allowed('--mode', command, 'headless')],
  ['--model', '<model-name>', 'Select an available model by its exact name', command => allowed('--model', command, 'headless')],
  ['--reasoning', 'low|medium|high|xhigh|max', 'Set reasoning effort', command => allowed('--reasoning', command, 'headless')],
  ['--wait', '', 'Wait for the reply after sending a message', command => allowed('--wait', command, 'headless')],
  ['--run', '<id>', 'Select a run for a session operation', command => allowed('--run', command, 'headless')],
  ['--runtime', 'local|cloud', 'Choose the task runtime', command => allowed('--runtime', command, 'headless')],
  ['--project', '<id-or-name|none>', 'Set task project context', command => allowed('--project', command, 'headless')],
  ['--enterprise-knowledge', '', 'Include enterprise knowledge in task context', command => allowed('--enterprise-knowledge', command, 'headless')],
  ['--workspace', '<path>', 'Set the task workspace', command => allowed('--workspace', command, 'headless')],
  ['--no-skills', '', 'Disable task skills', command => allowed('--no-skills', command, 'headless')],
  ['--permission', '<mode>', 'Set local task permission mode', command => allowed('--permission', command, 'headless')],
  ['--attach', '<path>', 'Attach a file to a new message', command => allowed('--attach', command, 'headless')],
  ['--expect-json', '', 'Require a JSON response', command => allowed('--expect-json', command, 'headless')],
  ['--reply-schema', '<path>', 'Validate a JSON response against a schema', command => allowed('--reply-schema', command, 'headless')],
  ['--mcp', '<connector-id>', 'Use an MCP connector with a local task', command => allowed('--mcp', command, 'headless')],
  ['--command', '<path>', 'Set the stdio MCP server executable', command => allowed('--command', command, 'headless')],
  ['--arg', '<value>', 'Add a stdio MCP server argument', command => allowed('--arg', command, 'headless')],
  ['--env', 'KEY=VALUE', 'Set a stdio MCP server environment variable', command => allowed('--env', command, 'headless')],
];

/** Options actually accepted by the Headless contract for a help topic. */
export function headlessOptionsForHelp(helpPath) {
  const paths = [helpPath];
  if (helpPath.length === 1) {
    const children = {
      sessions: ['list', 'current', 'open', 'read', 'create', 'send', 'status', 'wait', 'stop'],
      projects: ['list', 'create'],
      mcp: ['register', 'list', 'remove'],
      model: ['current', 'select', 'reasoning'],
    }[helpPath[0]] || [];
    paths.push(...children.map(child => [...helpPath, child]));
  }
  const matching = HEADLESS_HELP_OPTIONS.filter(([, , , supports]) => paths.some(supports));
  return matching.map(([flag, value, description]) => `  ${flag}${value ? ` ${value}` : ''}  ${description}`);
}

function optionError(flag, command, backend) {
  const webUnsupported = ['--profile', '--attach', '--model', '--reasoning', '--runtime', '--project',
    '--enterprise-knowledge', '--workspace', '--no-skills', '--permission', '--mcp', '--command', '--arg', '--env'];
  if (backend === 'web' && webUnsupported.includes(flag)) {
    return `${flag} is not supported on doubao web; use a desktop platform for task features`;
  }
  if (backend === 'headless' && flag === '--target') return '--target is not supported on doubao headless';
  if (flag === '--run') return '--run requires sessions status/wait/stop';
  if (flag === '--mode') return '--mode requires doubao web sessions create or doubao headless sessions create (or a matching --platform selector)';
  if (flag === '--timeout') return `${flag} is not valid for ${command.join(' ') || 'this command'}`;
  if (flag === '--yes') return '--yes requires cdp launch on a desktop platform';
  if (flag === '--limit') return '--limit requires sessions list or read';
  if (flag === '--target' && backend === 'web') return `--target is not used by doubao web ${command.join(' ')}`;
  if (flag === '--target') return '--target requires doubao web';
  if (flag === '--cookie-file') return '--cookie-file requires doubao headless login';
  if (flag === '--model') return `${flag} requires sessions create/send`;
  if (['--runtime', '--project', '--enterprise-knowledge'].includes(flag)) return 'Task context options require sessions create/send';
  if (flag === '--permission') return '--permission requires sessions create/send with --runtime local or --mcp';
  if (flag === '--wait') return `${backend === 'headless' ? 'Headless' : backend === 'web' ? 'Web' : 'Desktop'} --wait requires sessions create/send with a message`;
  if (flag === '--expect-json' || flag === '--reply-schema') return '--expect-json and --reply-schema require sessions create/send/wait';
  return `${flag} is not valid for ${command.join(' ') || 'this command'} on ${backend}`;
}

function validatePositionalContract(options) {
  const args = options.args || [];
  const [command, subcommand] = args;
  const fail = message => { throw new Error(message); };
  const exact = (count, message) => { if (args.length !== count) fail(message); };
  const minimum = (count, message) => { if (args.length < count) fail(message); };

  if (['status', 'capabilities', 'models', 'usage', 'profiles', 'runtimes'].includes(command)) exact(1, `${command} accepts no positional arguments`);
  if (command === 'sessions') {
    if (['list', 'current'].includes(subcommand)) exact(2, `sessions ${subcommand} accepts no positional arguments`);
    if (['read', 'open', 'status', 'wait', 'stop'].includes(subcommand)) exact(3, `sessions ${subcommand} requires exactly one conversation ID`);
  }
  if (command === 'cdp' && ['status', 'launch'].includes(subcommand)) exact(2, `cdp ${subcommand} accepts no positional arguments`);
  if (command === 'update') {
    if (!subcommand || subcommand === 'check') exact(subcommand ? 2 : 1, `update${subcommand ? ' check' : ''} accepts no positional arguments`);
    if (['auto', 'notify'].includes(subcommand) && args.length > 3) fail(`update ${subcommand} accepts one optional action: on, off, or status`);
  }
  if (command === 'mcp') {
    if (subcommand === 'list') exact(2, 'mcp list accepts no positional arguments');
    if (subcommand === 'remove') exact(3, 'mcp remove requires exactly one connector ID');
    if (subcommand === 'register') minimum(3, 'mcp register requires a connector name');
  }
  if (command === 'projects' && subcommand === 'list') exact(2, 'projects list accepts no positional arguments');
  if (command === 'projects' && subcommand === 'create') minimum(3, 'projects create requires a project name');
  if (command === 'model') {
    if (!subcommand) exact(1, 'model accepts no positional arguments');
    if (subcommand === 'current') exact(2, 'model current accepts no positional arguments');
    if (subcommand === 'select') minimum(3, 'model select requires a model name');
    if (subcommand === 'reasoning') exact(3, 'model reasoning requires exactly one effort level');
  }
}

/** Validate explicit option placement before any backend or update work begins. */
export function validateOptionContract(options, backend) {
  options = { ...options, backend };
  const [command, subcommand] = options.args;
  const path = [command, subcommand].filter(Boolean);
  const versionOnly = options.args.length === 1 && ['--version', '-v'].includes(command);
  const unknown = (options.unknownFlags || []).find(flag => !(versionOnly && flag === command));
  if (unknown) {
    if (command === 'projects' && subcommand === 'create') {
      throw new Error(`Unknown projects create option: ${unknown}. Run "doubao help"; use -- before a name starting with -`);
    }
    const label = backend === 'web' ? 'Web' : backend === 'headless' ? 'Headless' : '';
    throw new Error(`Unknown ${label ? `${label} ` : ''}option: ${unknown}; use -- before literal text`);
  }

  if (backend === 'headless' && options.args[0] === 'sessions' && options.args[1] === 'create'
    && !options.args.slice(2).join(' ').trim()) {
    const noMessageOptions = ['--attach', '--mode', '--model', '--reasoning', '--runtime', '--project',
      '--enterprise-knowledge', '--workspace', '--no-skills', '--permission', '--mcp', '--expect-json', '--reply-schema', '--wait'];
    const ignored = (options.explicitOptions || []).find(flag => noMessageOptions.includes(flag));
    if (ignored) throw new Error(`${ignored} requires a message in Headless sessions create`);
  }

  if (backend === 'headless' && options.mode === 'chat' && SESSION_CREATE_OR_SEND(path)) {
    const workOnly = ['--runtime', '--project', '--enterprise-knowledge', '--workspace', '--no-skills', '--permission', '--mcp'];
    const invalid = (options.explicitOptions || []).find(flag => workOnly.includes(flag));
    if (invalid) throw new Error(`${invalid} requires --mode work on doubao headless`);
  }

  for (const flag of options.explicitOptions || []) {
    if (!allowed(flag, path, backend)) throw new Error(optionError(flag, path, backend));
    if (flag === '--reasoning' && SESSION_CREATE_OR_SEND(path)) {
      const message = options.args.slice(path[1] === 'create' ? 2 : 3).join(' ').trim();
      if (!message) throw new Error('--reasoning requires a message');
    }
    if (flag === '--wait' && SESSION_CREATE_OR_SEND(path)) {
      const message = options.args.slice(path[1] === 'create' ? 2 : 3).join(' ').trim();
      if (!message && !options.expectJson && !options.replySchema) {
        throw new Error(`${backend === 'headless' ? 'Headless ' : backend === 'web' ? 'Web ' : ''}--wait requires a message`);
      }
    }
  }

  if (backend === 'headless' && options.limit > 100 && (options.args[0] === 'sessions'
    && (options.args[1] === 'list' || options.args[1] === 'read'))) {
    throw new Error('--limit requires an integer from 1 to 100 on doubao headless');
  }
  validatePositionalContract(options);
}
