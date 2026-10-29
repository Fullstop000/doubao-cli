// These modules have moved between desktop builds. Resolve by the observed
// source/export contract before requiring; requiring a missing id poisons cache.
export function appModule(req, kind) {
  // Match the webpack export declaration, not an unrelated nested property.
  const exportsKey = (source, key) => new RegExp('\\.d\\(\\w+,\\{[^}]*\\b' + key + ':').test(source);
  const definitions = {
    stores: { ids: [110872, 521109], match: s => s.includes('Wp:') && s.includes('chat-ioc-manager: store') },
    runtimeSelection: { ids: [438244], match: s => s.includes('getInputToolConversationRuntimeEnvironment:')
      && s.includes('getInputToolConversationStateSnapshot:') },
    attachments: { ids: [284642, 109595], match: s => /getAttachmentActions:\(\)=>[\w$]+(?:,|\})/u.test(s) && s.includes('attachmentStatesSelector:')
      && s.includes('attachmentsMap') && s.includes('attachmentsStore') },
    attachmentBlock: { ids: [907216, 613922], match: s => exportsKey(s, 'S') && s.includes('transform:') && s.includes('BLOCK_ATTACHMENT') && s.includes('attachmentStates:') },
    skills: { ids: [359531, 609347], match: s => exportsKey(s, 'skillsFacadeApiService') || exportsKey(s, 'Sf') && exportsKey(s, 'SI') },
    sandbox: { ids: [987391, 876207], match: s => s.includes('H:') && s.includes('resolvedSharedFolders:') && s.includes('projectFolders:') && s.length < 1500 },
    // ProjectStoreService exports th(), whose instance owns createProject().
    // The old error string was removed from newer desktop bundles.
    projects: { ids: [], match: s => s.includes('th:') && s.includes('async createProject(') && s.includes('async deleteProject(') },
    // Current builds bundle two equivalent helpers. 310092 is the one used by
    // createProjectCreationService; retain source validation before requiring it.
    projectDevice: { ids: [193447, 670245, 82197, 554995, 310092], match: s => exportsKey(s, 'U') && s.includes('project_shared_get_device_error') && s.includes('getDeviceInfo()') && s.length < 1500 },
  };
  if (kind === 'communication') {
    if (!req.m) return req(763283);
    const source = Object.values(req.m).map(f => f.toString()).find(s => s.includes('cua.local_file.sandbox_instance.update_conversation') && s.length < 1500);
    const id = source?.match(/var \w+=\w+\((\d+)\)/)?.[1];
    if (id) return req(Number(id));
    throw new Error('Doubao sandbox communication module is unavailable');
  }
  const def = definitions[kind];
  if (!def) throw new Error('Unknown Doubao module: ' + kind);
  if (!req.m) {
    if (def.ids.length) return req(def.ids[0]);
    throw new Error('Doubao ' + kind + ' module discovery is unavailable');
  }
  const load = id => {
    const module = req(id);
    return kind === 'skills' && module.skillsFacadeApiService
      ? { Sf: module.skillsFacadeApiService, iv: module.flowAgentGeneralApiService } : module;
  };
  for (const id of def.ids) if (req.m[id] && def.match(req.m[id].toString())) return load(id);
  const matches = Object.entries(req.m).filter(([, f]) => def.match(f.toString()));
  if (matches.length !== 1) throw new Error('Doubao ' + kind + ' module is unavailable or ambiguous; update the CLI');
  return load(Number(matches[0][0]));
}

export const APP_MODULE_BOOTSTRAP = `const appModule = ${appModule.toString()};`;
