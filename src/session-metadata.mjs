function nonzero(value) {
  if (value == null || value === '') return false;
  return /^\d+$/u.test(String(value)) ? BigInt(value) > 0n : null;
}

export function sessionMetadata(conversation) {
  return { conversationId: String(conversation.conversation_id), title: conversation.name ?? null,
    pinned: nonzero(conversation.pinned_time),
    archived: conversation.status === 8 ? true : conversation.status === 1 ? false : null,
    projectId: conversation.project_reference?.project_id ? String(conversation.project_reference.project_id) : null };
}
