const mutationChains = new WeakMap();

export function runStorageMutation(storage, operation) {
  if (!storage || typeof storage !== 'object' || typeof operation !== 'function') {
    throw new Error('Invalid storage mutation');
  }

  const previous = mutationChains.get(storage) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  mutationChains.set(storage, current);
  return current;
}
