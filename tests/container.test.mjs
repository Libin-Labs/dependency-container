import test from 'node:test';
import assert from 'node:assert/strict';
import { createContainer, createToken, ContainerError } from '../dist/esm/index.js';

test('supports async singleton initialization, typed dependency resolution, and reverse cleanup', async () => {
  const container = createContainer();
  const events = [];
  const config = createToken('config');
  const service = createToken('service');
  container
    .register(
      config,
      async () => {
        await Promise.resolve();
        return { value: 3, dispose: () => events.push('config') };
      },
      { lifetime: 'singleton' },
    )
    .register(
      service,
      async (resolver) => {
        const settings = await resolver.resolve(config);
        return { value: settings.value + 1, dispose: () => events.push('service') };
      },
      { lifetime: 'singleton' },
    );
  const [first, second] = await Promise.all([
    container.resolve(service),
    container.resolve(service),
  ]);
  assert.equal(first, second);
  assert.equal(first.value, 4);
  await container.dispose();
  assert.deepEqual(events, ['service', 'config']);
});

test('isolates scoped instances and rejects root scoped resolution', async () => {
  const container = createContainer();
  const value = createToken('scoped');
  let next = 0;
  container.register(value, () => ({ id: ++next }), { lifetime: 'scoped' });
  await assert.rejects(container.resolve(value), (error) => error.code === 'scope-required');
  const a = container.createScope();
  const b = container.createScope();
  assert.equal((await a.resolve(value)).id, 1);
  assert.equal((await a.resolve(value)).id, 1);
  assert.equal((await b.resolve(value)).id, 2);
  await a.dispose();
  await b.dispose();
  await container.dispose();
});

test('diagnoses dependency cycles with a path and missing registrations', async () => {
  const container = createContainer();
  const a = createToken('a');
  const b = createToken('b');
  container.register(a, (resolver) => resolver.resolve(b));
  container.register(b, (resolver) => resolver.resolve(a));
  await assert.rejects(
    container.resolve(a),
    (error) => error.code === 'cycle' && error.path.join(' -> ') === 'a -> b -> a',
  );
  await assert.rejects(
    container.resolve(createToken('missing')),
    (error) => error.code === 'missing-registration',
  );
  await container.dispose();
});

test('attempts all cleanup and reports explicit disposal failures', async () => {
  const container = createContainer();
  const first = createToken('first');
  const second = createToken('second');
  const events = [];
  container.register(first, () => 1, {
    dispose: () => {
      events.push('first');
      throw Error('failed');
    },
  });
  container.register(second, () => 2, { dispose: () => events.push('second') });
  await container.resolve(first);
  await container.resolve(second);
  await assert.rejects(
    container.dispose(),
    (error) => error instanceof ContainerError && error.code === 'disposal-failed',
  );
  assert.deepEqual(events, ['second', 'first']);
  await assert.rejects(container.resolve(first), (error) => error.code === 'disposed');
});

test('waits for in-flight async initialization before disposing its result', async () => {
  const container = createContainer();
  const service = createToken('delayed');
  const events = [];
  container.register(
    service,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { dispose: () => events.push('disposed') };
    },
    { lifetime: 'singleton' },
  );
  const resolving = container.resolve(service);
  const disposing = container.dispose();
  await resolving;
  await disposing;
  assert.deepEqual(events, ['disposed']);
});

test('prevents a singleton from retaining a scoped dependency', async () => {
  const container = createContainer();
  const scoped = createToken('scoped');
  const singleton = createToken('singleton');
  container.register(scoped, () => ({}), { lifetime: 'scoped' });
  container.register(singleton, (resolver) => resolver.resolve(scoped), { lifetime: 'singleton' });
  await assert.rejects(
    container.createScope().resolve(singleton),
    (error) => error.code === 'lifetime-capture',
  );
  await container.dispose();
});

test('owns scoped transients through scope cleanup and enforces depth limits', async () => {
  const container = createContainer({ maxResolutionDepth: 2 });
  const first = createToken('first');
  const second = createToken('second');
  const third = createToken('third');
  const events = [];
  container.register(third, () => ({ dispose: () => events.push('third') }));
  container.register(second, (resolver) => resolver.resolve(third));
  container.register(first, (resolver) => resolver.resolve(second));
  await assert.rejects(container.resolve(first), (error) => error.code === 'limit-exceeded');

  const scopedTransient = createToken('scoped-transient');
  container.register(scopedTransient, () => ({ dispose: () => events.push('scoped-transient') }));
  const scope = container.createScope();
  await scope.resolve(scopedTransient);
  await scope.dispose();
  assert.deepEqual(events, ['scoped-transient']);
  const rootTransient = createToken('root-transient');
  container.register(rootTransient, () => ({ dispose: () => events.push('root-transient') }));
  await container.resolve(rootTransient);
  await container.dispose();
  assert.deepEqual(events, ['scoped-transient', 'root-transient']);
});
