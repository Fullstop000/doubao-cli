import { evaluateWithWatchdog } from './protocol.mjs';
import { imRequest } from './turns.mjs';
import { requestDeadline } from './list-services.mjs';

// Keep the renderer's credentials in the app and pin one account for every page.
export function desktopListClient(client) {
  let accountId;
  const run = async (operation, timeoutMs) => {
    const remaining = requestDeadline(timeoutMs);
    const bounded = {
      evaluate: expression => evaluateWithWatchdog(client, expression, remaining()),
      close: () => client.close(),
    };
    const assertAccount = async () => {
      const id = await bounded.evaluate("localStorage.getItem('flow_tea_user_id')");
      if (!id || id === '0') throw Object.assign(new Error('Sign in to the selected Doubao app to read lists'), { code: 'login_required' });
      if (accountId && accountId !== id) {
        throw Object.assign(new Error('Doubao account changed during list lookup'), { code: 'account_changed' });
      }
      accountId = id;
    };
    await assertAccount();
    const result = await operation(bounded, remaining);
    await assertAccount();
    remaining();
    return result;
  };
  return {
    imRequest: (route, cmd, key, body, timeoutMs) => run(
      (bounded, remaining) => imRequest(bounded, route, cmd, key, body, remaining()), timeoutMs),
    evaluate: (expression, timeoutMs) => run(bounded => bounded.evaluate(expression), timeoutMs),
  };
}
