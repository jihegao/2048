// At upload, the reviewed runner substitutes the preserved OLD main module name.
import original from './__2048_original_module__.js';
import { migrationKeyProof } from './lib/migration-key-proof';
export { RoomSession, LoginGuard } from './__2048_original_module__.js';

export default {
  ...original,
  async fetch(request, env, context) {
    return (await migrationKeyProof(request, env)) ?? original.fetch(request, env, context);
  },
};
