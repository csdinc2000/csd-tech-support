/**
 * Express 5 types every `req.params` value as `string | string[]`, because a
 * wildcard segment (`/*rest`) can match several path segments at once. A named
 * parameter (`/:id`) never can, so reading one through this helper both
 * satisfies the type and fails loudly if a route is later changed to a wildcard
 * — instead of silently stringifying an array into the query layer.
 */
export function routeParam(value: string | string[] | undefined, name: string): string {
  if (typeof value === "string") return value;
  if (value === undefined) throw new Error(`Missing route parameter "${name}"`);
  throw new Error(`Route parameter "${name}" matched multiple path segments`);
}
