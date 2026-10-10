export const secretNames: string[];
export function buildProof(
  secrets: Record<string, string>,
  audience: string,
): {
  payload: unknown;
  authorization: string;
};
