import application from './index';
import { maintenanceResponse } from './lib/migration';
import { authorizedCandidateRequest } from './lib/migration-candidate-gate';
import { migrationKeyProof } from './lib/migration-key-proof';

export { LoginGuard, RoomSession } from './index';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const proof = await migrationKeyProof(request, env);
    if (proof) return proof;
    const authorized = await authorizedCandidateRequest(request, env);
    if (!authorized) return maintenanceResponse();
    // The application still checks the D1 fence, normal authentication, roles
    // and Origin. A valid operator signature alone cannot open a frozen DB.
    return application.fetch(authorized, env, ctx);
  },
  async scheduled(): Promise<void> {
    // Acceptance is controlled by the operator. Cron stays off until release.
  },
};
