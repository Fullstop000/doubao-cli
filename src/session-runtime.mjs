export function sessionRuntime(conversation, selectedRuntimeType) {
  const parse = value => {
    try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
  };
  const extra = parse(conversation.conv_extra ?? conversation.extra);
  const agentParam = parse(extra?.agent_task_param);
  // Works uses the current selection, then saved context, then Cloud VM.
  const type = selectedRuntimeType ?? agentParam?.runtime_type ?? 1;
  return type === 2 ? 'local' : type === 1 ? 'cloud' : 'unknown';
}
