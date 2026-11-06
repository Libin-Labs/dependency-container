# @lp-labs/dependency-container

Typed token-based dependency registrations with singleton, scoped, and transient lifetimes.
Resolution is asynchronous by design so factories can initialize safely.

## Install and quickstart

```bash
npm install @lp-labs/dependency-container
```

```js
import { createContainer, createToken } from '@lp-labs/dependency-container';

const settings = createToken('settings');
const service = createToken('service');
const container = createContainer();
container.register(settings, async () => ({ endpoint: 'memory:' }), { lifetime: 'singleton' });
container.register(
  service,
  async (resolver) => ({
    endpoint: (await resolver.resolve(settings)).endpoint,
  }),
  { lifetime: 'transient' },
);
const instance = await container.resolve(service);
if (instance.endpoint !== 'memory:') throw new Error('Initialization failed');
await container.dispose();
```

Both ESM and CommonJS entry points ship declarations. CommonJS:
`require('@lp-labs/dependency-container')`.

## API, types, and lifetimes

- `createToken<T>(name)` creates a typed opaque registration key.
- `createContainer(options?)` returns `Container`. `register(token, factory, options?)` is
  chainable; `resolve(token)` always returns `Promise<T>`. Factories receive a `Resolver` supporting
  asynchronous typed dependencies.
- `createScope()` returns a `Scope`; scoped services must be resolved from one. Repeated
  resolutions within a scope share one instance. Different scopes are isolated.
- `Lifetime` is `singleton | scoped | transient`. Singleton instances are shared by the root
  container; transients are created on each resolution. All created instances are owned for
  cleanup by the root or the scope that created them.
- `RegistrationOptions<T>` selects a lifetime and optional async/sync `dispose(value)` callback.
  Without a callback, an object instance's `asyncDispose()` or `dispose()` method is used when
  present. Cleanup runs in reverse creation order; all cleanup callbacks are attempted.
- `ContainerOptions.maxRegistrations` defaults to 1,000 (maximum 10,000).
- `ContainerOptions.maxResolutionDepth` defaults to 128 (maximum 1,024).
- `ContainerError` exposes `code`, optional cycle `path`, and cleanup `errors`.

## Failures, disposal, and limits

Missing registrations, root resolution of scoped services, singleton capture of scoped services,
duplicate registrations, cycles, use after disposal, and capacity/depth exhaustion throw
`ContainerError`. Cycle paths name the repeated
dependency chain. Factory errors reject their resolution and are not cached; a later request may
retry. Concurrent singleton/scoped initialization is shared. `dispose()` is idempotent and waits
for in-flight construction before attempting reverse-order cleanup. Cleanup failures are reported
as `disposal-failed` after remaining cleanup attempts complete. A service whose factory fails
before returning a value cannot be automatically disposed; factories should clean partial
resources before rejecting.

The container does not infer registrations, inspect constructors, proxy scopes, enforce lifetime
capture rules, or provide request-local context. Factories and disposer callbacks are trusted
application code; no timeout or sandbox is provided.

No runtime or peer dependencies.

## Runtime exports

`createToken`, `createContainer`, and `ContainerError`.

Types: `Lifetime`, `Token`, `Resolver`, `ContainerOptions`, `RegistrationOptions`, `Container`,
and `Scope`.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
