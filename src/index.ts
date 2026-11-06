export type Lifetime = 'singleton' | 'scoped' | 'transient';

export interface Token<T> {
  readonly name: string;
  readonly __type?: T;
}

export interface Resolver {
  resolve<T>(token: Token<T>): Promise<T>;
}

export interface ContainerOptions {
  maxRegistrations?: number;
  maxResolutionDepth?: number;
}

export interface RegistrationOptions<T> {
  lifetime?: Lifetime;
  dispose?: (value: T) => void | PromiseLike<void>;
}

export interface Container {
  register<T>(
    token: Token<T>,
    factory: (resolver: Resolver) => T | PromiseLike<T>,
    options?: RegistrationOptions<T>,
  ): this;
  resolve<T>(token: Token<T>): Promise<T>;
  createScope(): Scope;
  dispose(): Promise<void>;
}

export interface Scope extends Resolver {
  dispose(): Promise<void>;
}

export class ContainerError extends Error {
  constructor(
    readonly code:
      | 'invalid-token'
      | 'duplicate-registration'
      | 'missing-registration'
      | 'scope-required'
      | 'lifetime-capture'
      | 'cycle'
      | 'disposed'
      | 'limit-exceeded'
      | 'disposal-failed',
    message: string,
    readonly path?: readonly string[],
    readonly errors?: readonly unknown[],
  ) {
    super(message);
    this.name = 'ContainerError';
  }
}

interface Registration<T = unknown> {
  token: Token<T>;
  factory: (resolver: Resolver) => T | PromiseLike<T>;
  lifetime: Lifetime;
  dispose?: (value: T) => void | PromiseLike<void>;
}

interface OwnedInstance {
  registration: Registration;
  value: unknown;
}

interface CacheEntry {
  promise: Promise<unknown>;
}

const isToken = (token: unknown): token is Token<unknown> =>
  Boolean(
    token &&
    typeof token === 'object' &&
    typeof (token as Token<unknown>).name === 'string' &&
    (token as Token<unknown>).name.length > 0 &&
    (token as Token<unknown>).name.length <= 128,
  );

export function createToken<T>(name: string): Token<T> {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 128) {
    throw new ContainerError('invalid-token', 'Token names must contain 1..128 characters.');
  }
  return Object.freeze({ name }) as Token<T>;
}

export function createContainer(options: ContainerOptions = {}): Container {
  const maximum = options.maxRegistrations ?? 1_000;
  const maxDepth = options.maxResolutionDepth ?? 128;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10_000) {
    throw new RangeError('maxRegistrations must be an integer from 1 through 10000.');
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_024) {
    throw new RangeError('maxResolutionDepth must be an integer from 1 through 1024.');
  }
  const registrations = new Map<Token<unknown>, Registration>();
  const singletonCache = new Map<Token<unknown>, CacheEntry>();
  const instances: OwnedInstance[] = [];
  const pending = new Set<Promise<unknown>>();
  const scopes = new Set<ScopeImpl>();
  let closed = false;
  let disposing: Promise<void> | undefined;

  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  };

  const disposeInstances = async (owned: OwnedInstance[]): Promise<void> => {
    const errors: unknown[] = [];
    for (let index = owned.length - 1; index >= 0; index--) {
      const { registration, value } = owned[index]!;
      try {
        if (registration.dispose) {
          await registration.dispose(value);
        } else if (value && typeof value === 'object') {
          const resource = value as { asyncDispose?: unknown; dispose?: unknown };
          if (typeof resource.asyncDispose === 'function') await resource.asyncDispose.call(value);
          else if (typeof resource.dispose === 'function') await resource.dispose.call(value);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    owned.length = 0;
    if (errors.length > 0) {
      throw new ContainerError(
        'disposal-failed',
        `${errors.length} service cleanup operation(s) failed.`,
        undefined,
        errors,
      );
    }
  };

  const waitPending = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };

  const resolveInternal = <T>(
    token: Token<T>,
    scope: ScopeImpl | undefined,
    path: readonly Token<unknown>[],
    nested: boolean,
  ): Promise<T> => {
    if (!isToken(token))
      return Promise.reject(new ContainerError('invalid-token', 'Invalid service token.'));
    if (closed && !nested)
      return Promise.reject(new ContainerError('disposed', 'Container is disposed.'));
    const registration = registrations.get(token as Token<unknown>) as Registration<T> | undefined;
    if (!registration) {
      return Promise.reject(
        new ContainerError('missing-registration', `No service registered for ${token.name}.`),
      );
    }
    const cycleAt = path.findIndex((entry) => entry === token);
    if (cycleAt >= 0) {
      const cycle = [...path.slice(cycleAt).map((entry) => entry.name), token.name];
      return Promise.reject(
        new ContainerError('cycle', `Dependency cycle: ${cycle.join(' -> ')}.`, cycle),
      );
    }
    if (path.length >= maxDepth) {
      return Promise.reject(
        new ContainerError('limit-exceeded', `Resolution depth exceeds ${maxDepth}.`),
      );
    }
    if (
      registration.lifetime === 'scoped' &&
      path.some((dependency) => registrations.get(dependency)?.lifetime === 'singleton')
    ) {
      return Promise.reject(
        new ContainerError(
          'lifetime-capture',
          `Singleton resolution cannot capture scoped service ${token.name}.`,
        ),
      );
    }
    if (registration.lifetime === 'scoped' && !scope) {
      return Promise.reject(
        new ContainerError('scope-required', `Service ${token.name} requires a scope.`),
      );
    }

    const cache =
      registration.lifetime === 'singleton'
        ? singletonCache
        : registration.lifetime === 'scoped'
          ? scope!.cache
          : undefined;
    const existing = cache?.get(token as Token<unknown>);
    if (existing) return existing.promise as Promise<T>;

    const nextPath = [...path, token as Token<unknown>];
    const dependencyScope = registration.lifetime === 'singleton' ? undefined : scope;
    const scopedOwner =
      registration.lifetime === 'scoped' ||
      (registration.lifetime === 'transient' && dependencyScope !== undefined);
    const ownerPending = scopedOwner ? dependencyScope!.pending : pending;
    const ownerInstances = scopedOwner ? dependencyScope!.instances : instances;
    const promise = Promise.resolve().then(async () => {
      const resolver: Resolver = {
        resolve: <U>(dependency: Token<U>) =>
          resolveInternal(dependency, dependencyScope, nextPath, true),
      };
      const instance = await registration.factory(resolver);
      ownerInstances.push({ registration: registration as Registration, value: instance });
      return instance;
    });
    const tracked = track(promise);
    if (ownerPending !== pending) {
      ownerPending.add(tracked);
      void tracked.finally(() => ownerPending.delete(tracked)).catch(() => undefined);
    }
    cache?.set(token as Token<unknown>, { promise: tracked });
    if (cache) {
      void tracked.catch(() => {
        if (cache.get(token as Token<unknown>)?.promise === tracked)
          cache.delete(token as Token<unknown>);
      });
    }
    return tracked;
  };

  class ScopeImpl implements Scope {
    readonly cache = new Map<Token<unknown>, CacheEntry>();
    readonly instances: OwnedInstance[] = [];
    readonly pending = new Set<Promise<unknown>>();
    private closing = false;
    private disposed?: Promise<void>;

    resolve<T>(token: Token<T>): Promise<T> {
      if (this.closing) return Promise.reject(new ContainerError('disposed', 'Scope is disposed.'));
      return resolveInternal(token, this, [], false);
    }

    dispose(): Promise<void> {
      if (this.disposed) return this.disposed;
      this.closing = true;
      this.disposed = (async () => {
        while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
        scopes.delete(this);
        try {
          await disposeInstances(this.instances);
        } finally {
          this.cache.clear();
        }
      })();
      return this.disposed;
    }
  }

  return {
    register<T>(
      token: Token<T>,
      factory: (resolver: Resolver) => T | PromiseLike<T>,
      options: RegistrationOptions<T> = {},
    ) {
      if (closed) throw new ContainerError('disposed', 'Container is disposed.');
      if (!isToken(token) || typeof factory !== 'function') {
        throw new ContainerError('invalid-token', 'A valid token and factory are required.');
      }
      if (registrations.has(token as Token<unknown>)) {
        throw new ContainerError(
          'duplicate-registration',
          `Service ${token.name} is already registered.`,
        );
      }
      if (registrations.size >= maximum) {
        throw new ContainerError('limit-exceeded', 'Registration limit reached.');
      }
      const lifetime = options.lifetime ?? 'transient';
      if (!['singleton', 'scoped', 'transient'].includes(lifetime)) {
        throw new TypeError('Unknown service lifetime.');
      }
      const registration: Registration<T> = { token, factory, lifetime };
      if (options.dispose) registration.dispose = options.dispose;
      registrations.set(token as Token<unknown>, registration as Registration);
      return this;
    },
    resolve<T>(token: Token<T>) {
      return resolveInternal(token, undefined, [], false);
    },
    createScope() {
      if (closed) throw new ContainerError('disposed', 'Container is disposed.');
      const scope = new ScopeImpl();
      scopes.add(scope);
      return scope;
    },
    dispose() {
      if (disposing) return disposing;
      closed = true;
      disposing = (async () => {
        const errors: unknown[] = [];
        for (const scope of [...scopes]) {
          try {
            await scope.dispose();
          } catch (error) {
            errors.push(error);
          }
        }
        await waitPending();
        try {
          await disposeInstances(instances);
        } catch (error) {
          errors.push(error);
        }
        singletonCache.clear();
        if (errors.length > 0) {
          throw new ContainerError(
            'disposal-failed',
            `${errors.length} scope or container cleanup operation(s) failed.`,
            undefined,
            errors,
          );
        }
      })();
      return disposing;
    },
  };
}
