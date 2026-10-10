declare global {
  namespace Cloudflare {
    interface Env {
      TEST_FENCE_SQL: string;
      TEST_FIXTURE_INSERTS: string[];
      TEST_NODE_KEY_PROOF_AUTH: string;
    }
  }
}
export {};
