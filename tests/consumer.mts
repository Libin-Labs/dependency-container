import {
  createContainer,
  createToken,
  type Container,
  type Resolver,
} from '@lp-labs/dependency-container';

interface Database {
  readonly url: string;
}
const database = createToken<Database>('database');
const container: Container = createContainer({ maxResolutionDepth: 32 });
container.register(database, async (_resolver: Resolver) => ({ url: 'memory:' }), {
  lifetime: 'singleton',
});
const resolved: Database = await container.resolve(database);
await container.dispose();
void resolved;
