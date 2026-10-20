import { randomUUID } from 'node:crypto';

// Native request construction is separate from authentication and runtime lifecycle.
export function completionBody({ conversationId = '', message, mode = 'work', model, reasoning, taskContext, localTaskParam, attachmentBlocks = [], localMessageId = randomUUID(), goalId }) {
  const work = mode !== 'chat';
  const generalTask = { action: 0, thread_local_message_id: [localMessageId], runtime_type: 1,
    agent_task_param: { runtime_type: 1 }, agent_task_param_change: { runtime_changed: false, device_changed: false, sandbox_auth_type_changed: false },
    need_modify_conversation: false, task_input_json: JSON.stringify({ schema_version: 1, project_context: {} }) };
  if (taskContext) {
    generalTask.task_input_json = JSON.stringify({ schema_version: 1, project_context: taskContext.projectContext || {} });
    if (taskContext.enterpriseSkill) {
      const skill = taskContext.enterpriseSkill;
      generalTask.selected_skills = [skill.name];
      generalTask.skill_selections = [{ name: skill.name, skill_type: skill.type, skill_id: skill.externalId }];
    }
  }
  if (localTaskParam) Object.assign(generalTask, localTaskParam, { thread_local_message_id: [localMessageId] });
  if (taskContext) {
    const previous = taskContext.previousAgentParam || {};
    const next = generalTask.agent_task_param;
    const existing = Boolean(conversationId);
    generalTask.agent_task_param_change = {
      runtime_changed: existing && previous.runtime_type !== next.runtime_type,
      device_changed: existing && ((previous.local_device_id || '') !== (next.local_device_id || '') || (previous.local_app_id || '') !== (next.local_app_id || '')),
      sandbox_auth_type_changed: existing && previous.sandbox_auth_type !== next.sandbox_auth_type,
    };
    const projectChanged = existing && (taskContext.previousProjectId || '') !== (taskContext.projectId || '');
    if (projectChanged) generalTask.project_id = taskContext.projectId || '';
    generalTask.need_modify_conversation = existing && (projectChanged || Object.keys(next).some(key => previous[key] !== next[key]));
  }
  if (mode === 'goal') {
    if (!goalId) throw new Error('Goal mode requires a verified goal ID');
    generalTask.action = 4;
    generalTask.goal_param = { goal_id: goalId };
  }
  const init = { need_ack_conversation: true, ...(taskContext?.projectId ? { project_id: taskContext.projectId } : {}) };
  return {
    client_meta: { local_conversation_id: 'local_' + Date.now() + '_' + randomUUID(), conversation_id: conversationId,
      bot_id: '7338286299411103781', last_section_id: '', last_message_index: null },
    messages: [{ local_message_id: localMessageId, content_block: [{ block_type: 10000,
      content: { text_block: { text: message } }, block_id: randomUUID() }, ...attachmentBlocks], message_status: 0 }],
    option: { create_time_ms: Date.now(), agent_mode: work ? 1 : 2, need_deep_think: model?.needDeepThink ?? (work ? 9 : 0), unique_key: randomUUID(),
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 },
      need_create_conversation: !conversationId, is_old_user: true, message_from: 0,
      sse_recv_event_options: { support_chunk_delta: true }, general_task_param: generalTask,
      ...(taskContext?.activeGoalId ? { active_goal_id: taskContext.activeGoalId } : {}),
      ...(!conversationId ? { conversation_init_option: init, conversation_init_ext: { mode_id: work ? '3' : '1', ...(model ? { model_item_key: model.id } : {}),
        ...(reasoning ? { reasoning_effort: reasoning } : {}), ...(localTaskParam ? { agent_task_param: JSON.stringify(localTaskParam.agent_task_param) } : {}) } } : {}),
      ...(model ? { model_config: { model_item_key: model.id, ...(reasoning ? { reasoning_effort: Number(reasoning) } : {}) },
        aggregate_params: { provider_id: model.provider || '', ...(reasoning ? { reasoning_effort: reasoning } : {}) } } : {}) },
    ext: { ...(taskContext?.activeGoalId ? { active_goal_id: taskContext.activeGoalId } : {}), ...(mode === 'goal' ? { leading_accessory_tags: JSON.stringify([{ tag: 'goal', display_text: '目标' }]) } : {}), general_task_param: JSON.stringify(generalTask), use_deep_think: String(model?.needDeepThink ?? (work ? 9 : 0)), agent_mode: work ? '1' : '2',
      sub_conv_firstmet_type: '1', collection_id: '', is_finish: '1', conversation_init_option: JSON.stringify(init), commerce_credit_config_enable: '0' },
    user_context: [],
  };
}

