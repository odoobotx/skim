// Small local bus for synthetic backend updates; no cross-window transport.
const listeners = new Map<string, Set<(event: {payload: any}) => void>>();
export function emitDemo(event: string, payload: unknown) {
  for (const handler of listeners.get(event) ?? []) handler({payload});
}
export async function listen<T = unknown>(
  event: string,
  handler: (e: { payload: T }) => void,
): Promise<() => void> {
  const handlers=listeners.get(event) ?? new Set();
  handlers.add(handler);listeners.set(event,handlers);
  return () => {handlers.delete(handler);};
}

export async function once<T = unknown>(
  _event: string,
  _handler: (e: { payload: T }) => void,
): Promise<() => void> {
  const stop=await listen(_event,event => {stop();_handler(event as {payload:T});});
  return stop;
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {}
export async function emitTo(_target: string, _event: string, _payload?: unknown): Promise<void> {}
