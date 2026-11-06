import {
  createContainer,
  createToken,
  type Scope,
  type RegistrationOptions,
} from '@lp-labs/dependency-container';

interface Clock {
  now(): number;
}
const clock = createToken<Clock>('clock');
const options: RegistrationOptions<Clock> = { lifetime: 'scoped' };
const container = createContainer().register(clock, () => ({ now: () => Date.now() }), options);
const scope: Scope = container.createScope();
const current: Promise<Clock> = scope.resolve(clock);
void current;
