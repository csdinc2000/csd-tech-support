import { QueryClient, type QueryFunction } from "@tanstack/react-query";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown, fallbackMessage: string) {
    const payloadMessage = payload && typeof payload === "object" && "message" in payload
      ? String(payload.message)
      : fallbackMessage;
    super(`${status}: ${payloadMessage}`);
    this.name = "ApiRequestError";
    this.status = status;
    this.payload = payload;
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {
      // Preserve non-JSON error responses as text.
    }
    throw new ApiRequestError(res.status, payload, text);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  options?: Omit<RequestInit, "method" | "body" | "headers" | "credentials"> & {
    body?: BodyInit | null;
    headers?: HeadersInit;
  },
): Promise<Response> {
  const body = options?.body ?? (data ? JSON.stringify(data) : undefined);
  const headers = new Headers(options?.headers);
  if (data && !options?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, {
    ...options,
    method,
    headers,
    body,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

let cachedUserId: string | null | undefined;

export function synchronizeQueryCacheUser(userId: string | null): void {
  if (cachedUserId !== undefined && cachedUserId !== userId) {
    queryClient.clear();
  }
  cachedUserId = userId;
}

export function clearUserScopedQueryCache(): void {
  queryClient.clear();
  cachedUserId = null;
}
