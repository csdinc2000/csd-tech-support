import assert from "node:assert/strict";
import test from "node:test";
import {
  clearUserScopedQueryCache,
  queryClient,
  synchronizeQueryCacheUser,
} from "./queryClient.ts";

test("preserves cached data for the same user and clears it when identity changes", () => {
  clearUserScopedQueryCache();
  synchronizeQueryCacheUser("staff-a");
  queryClient.setQueryData(["/api/customers"], [{ id: 1 }]);

  synchronizeQueryCacheUser("staff-a");
  assert.deepEqual(queryClient.getQueryData(["/api/customers"]), [{ id: 1 }]);

  synchronizeQueryCacheUser("staff-b");
  assert.equal(queryClient.getQueryData(["/api/customers"]), undefined);
});

test("clears cached data immediately on explicit sign-out", () => {
  synchronizeQueryCacheUser("staff-a");
  queryClient.setQueryData(["/api/alerts/active"], [{ id: 1 }]);

  clearUserScopedQueryCache();

  assert.equal(queryClient.getQueryData(["/api/alerts/active"]), undefined);
});