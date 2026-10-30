import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Unlike post-merge.test.mjs, this invokes the installed Orval and TypeScript.
// Only the tiny fixture is generated; no workspace codegen/build script runs.
test("installed Orval emits compatible React Query and Zod staff clients", { timeout: 120_000 }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "generator-compatibility-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, content) => writeFileSync(path.join(dir, name), content);
  const quote = JSON.stringify;
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    TMPDIR: dir,
    NO_COLOR: "1",
  }; // No database URLs, provider credentials, or inherited application secrets.
  const run = (executable, args, label) => {
    const result = spawnSync(process.execPath, [executable, ...args], {
      cwd: dir, env, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${label} failed:\n${result.stdout}\n${result.stderr}`);
    return result;
  };

  // Resolve against the actual library runtimes and staff app's React types,
  // not ad-hoc versions installed for the test.
  mkdirSync(path.join(dir, "node_modules/@types"), { recursive: true });
  for (const [name, source] of [
    ["@tanstack", "lib/api-client-react/node_modules/@tanstack"],
    ["zod", "lib/api-zod/node_modules/zod"],
    ["react", "artifacts/csd-rmm-crm/node_modules/react"],
    ["@types/react", "artifacts/csd-rmm-crm/node_modules/@types/react"],
  ]) {
    symlinkSync(path.join(root, source), path.join(dir, "node_modules", name), "dir");
  }
  copyFileSync(new URL("./fixtures/generator-compatibility.openapi.json", import.meta.url), path.join(dir, "openapi.json"));
  copyFileSync(path.join(root, "lib/api-client-react/src/custom-fetch.ts"), path.join(dir, "custom-fetch.ts"));

  // Import the production config so generator options (including Zod version,
  // coercion, title transformer and fetch return shape) cannot drift unnoticed.
  // Replace every output destination BEFORE Orval executes clean:true.
  write("orval.config.ts", `
import config from ${quote(path.join(root, "lib/api-spec/orval.config.ts"))};
import path from "node:path";
const here = __dirname;
export default Object.fromEntries(Object.entries(config).map(([name, project]) => [
  name,
  {
    ...project,
    input: { ...project.input, target: path.join(here, "openapi.json") },
    output: {
      ...project.output,
      workspace: path.join(here, name),
      target: "generated",
      schemas: name === "zod" ? { ...project.output.schemas, path: "generated/types" } : undefined,
      prettier: false,
      override: {
        ...project.output.override,
        ...(name === "api-client-react" ? {
          mutator: { ...project.output.override.mutator, path: path.join(here, "custom-fetch.ts") }
        } : {})
      }
    }
  }
]));
`);
  run(path.join(root, "lib/api-spec/node_modules/orval/dist/bin/orval.mjs"),
    ["--config", path.join(dir, "orval.config.ts")], "Orval generation");

  const client = readFileSync(path.join(dir, "api-client-react/generated/api.ts"), "utf8");
  const schemas = readFileSync(path.join(dir, "zod/generated/api.ts"), "utf8");
  for (const name of ["listStaff", "useListStaff", "getListStaffQueryKey", "getListStaffQueryOptions",
    "updateStaff", "useUpdateStaff", "getUpdateStaffMutationOptions"]) {
    assert.match(client, new RegExp(`export (?:const|function) ${name}\\b`), `Missing React Query export ${name}`);
  }
  for (const name of ["ListStaffQueryParams", "ListStaffResponse", "UpdateStaffParams", "UpdateStaffBody", "UpdateStaffResponse"]) {
    assert.match(schemas, new RegExp(`export const ${name}\\b`), `Missing Zod export ${name}`);
  }

  // A staff-page-shaped consumer exercises inferred data, query options/keys,
  // mutation variables and Zod output types, not just generated-file syntax.
  write("consumer.ts", `
import { QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";
import {
  listStaff, useListStaff, getListStaffQueryKey, getListStaffQueryOptions,
  updateStaff, useUpdateStaff, getUpdateStaffMutationOptions
} from "./api-client-react/generated/api";
import type { Staff, StaffUpdate } from "./api-client-react/generated/api.schemas";
import {
  ListStaffQueryParams, ListStaffResponse, UpdateStaffParams,
  UpdateStaffBody, UpdateStaffResponse
} from "./zod/generated/api";

const params = { offset: 0, active: true };
const queryClient = new QueryClient();
const key = getListStaffQueryKey(params);
queryClient.invalidateQueries({ queryKey: key });
const fetched: Promise<Staff[]> = queryClient.fetchQuery(getListStaffQueryOptions(params));
const direct: Promise<Staff[]> = listStaff(params);
const body: StaffUpdate = { name: "Example" };
const updated: Promise<Staff> = updateStaff(1, body);
const mutationOptions = getUpdateStaffMutationOptions();
mutationOptions.mutationFn?.({ id: 1, data: body }, {} as never);

export function useStaffPage() {
  const query: UseQueryResult<Staff[] | undefined, Error | null> = useListStaff(params);
  const mutation = useUpdateStaff();
  mutation.mutate({ id: 1, data: body });
  const name: string | undefined = query.data?.[0]?.name;
  return { query, mutation, name };
}

const querySchema: z.ZodTypeAny = ListStaffQueryParams;
const bodySchema: z.ZodTypeAny = UpdateStaffBody;
const parsedBody: StaffUpdate = UpdateStaffBody.parse(body);
const parsedList: z.infer<typeof ListStaffResponse> = ListStaffResponse.parse([]);
const parsedStaff: z.infer<typeof UpdateStaffResponse> = UpdateStaffResponse.parse({});
const nullableDate: Date | null = parsedStaff.lastSeen;
const role: "owner" | "staff" = parsedStaff.role;
const id: number = UpdateStaffParams.parse({ id: "1" }).id;
// These must remain errors; widening generated data to any is incompatible too.
// @ts-expect-error Unknown roles are not valid staff records.
const invalidRole: z.infer<typeof UpdateStaffResponse>["role"] = "guest";
// @ts-expect-error Mutation bodies must retain their required name.
const invalidBody: StaffUpdate = {};
`);
  write("tsconfig.json", JSON.stringify({
    extends: path.join(root, "tsconfig.base.json"),
    compilerOptions: { noEmit: true, incremental: false, lib: ["es2022", "dom"] },
    include: ["consumer.ts", "custom-fetch.ts", "api-client-react/**/*.ts", "zod/**/*.ts"],
  }));
  run(path.join(root, "node_modules/typescript/bin/tsc"),
    ["--project", path.join(dir, "tsconfig.json")], "Generated client compilation");
});