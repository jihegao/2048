export function candidateHeaders(
  key: string,
  versionId: string,
  route: string,
  method?: string,
  body?: string,
): Record<string, string>;
export class CandidateClient {
  constructor(key: string, versionId: string, transport?: typeof fetch);
  request(route: string, method?: string, value?: unknown): Promise<Response>;
  websocket(route: string): { url: string; headers: Record<string, string> };
  clearCookies(): void;
}
