import type { UserSummary } from '../shared/types';

export type AuthUser = UserSummary & { sessionHash: string };

export type AppVariables = {
  user: AuthUser;
  requestId: string;
};

export type AppBindings = Env;

export type AppHonoEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
