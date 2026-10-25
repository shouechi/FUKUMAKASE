import { vi } from "vitest";

export type Query = {
  table: string;
  action: string;
  payload?: any;
  filters: [string, string, unknown][];
};
export function fakeDatabase(
  resolve: (query: Query) => any = () => [],
  rpcResolve: (name: string, args: any) => any = () => true,
) {
  const queries: Query[] = [];
  const from = vi.fn((table: string) => {
    const query: Query = { table, action: "select", filters: [] };
    const chain: any = {};
    for (const method of ["select", "insert", "update", "upsert", "delete"])
      chain[method] = (payload?: any) => {
        if (method !== "select" || query.action === "select")
          query.action = method;
        if (method !== "select") query.payload = payload;
        return chain;
      };
    for (const method of ["eq", "neq", "is", "in", "gte", "lte", "lt", "gt"])
      chain[method] = (column: string, value: unknown) => {
        query.filters.push([method, column, value]);
        return chain;
      };
    chain.or = (filter: string) => {
      query.filters.push(["or", filter, undefined]);
      return chain;
    };
    for (const method of ["order", "range", "limit", "single", "maybeSingle"])
      chain[method] = () => chain;
    chain.then = (fulfilled: any, rejected: any) => {
      queries.push(structuredClone(query));
      return Promise.resolve()
        .then(() => resolve(query))
        .then((value) =>
          value?.__error
            ? { data: null, error: value.__error }
            : {
                data: value,
                error: null,
                count: Array.isArray(value) ? value.length : undefined,
              },
        )
        .then(fulfilled, rejected);
    };
    return chain;
  });
  const rpc = vi.fn(async (name: string, args: any) => ({
    data: await rpcResolve(name, args),
    error: null,
  }));
  return { from, rpc, queries };
}
