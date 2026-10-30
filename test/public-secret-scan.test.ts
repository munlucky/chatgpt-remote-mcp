import { expect, it } from "vitest";

const helperUrl = new URL("../scripts/public-secret-scan.mjs", import.meta.url).href;
const { findPublicSecretLeaks } = await import(helperUrl);

it("does not misclassify documented runtime paths and URLs as credentials", () => {
  const env = { SHARED_PATH: "/shared/foo", KERNEL_PROFILE_TARGET: "/root/.moon-relay-kernel", MCP_PUBLIC_URL: "https://demo.example.com" };
  const files = [{ path: "docs/readme.md", content: "Use /shared/foo and /root/.moon-relay-kernel at https://demo.example.com" }];
  expect(findPublicSecretLeaks(env, "", files)).toEqual([]);
});

it("detects credentials in public files, including newly named credential keys", () => {
  const env = { MCP_AUTH_TOKEN: "private-auth-token-1234567", PROVIDER_API_KEY: "private-api-key-789123", SERVICE_PASSWORD: "private-password-012345" };
  const files = [
    { path: "src/a.ts", content: "const token = 'PRIVATE-AUTH-TOKEN-1234567';" },
    { path: "docs/b.md", content: "private-api-key-789123" },
    { path: "docs/c.md", content: "private-password-012345" },
    { path: "docs/clean.md", content: "No secrets" },
  ];
  expect(findPublicSecretLeaks(env, "", files)).toEqual(["src/a.ts", "docs/b.md", "docs/c.md"]);
});

it("does not treat short or example placeholder values as private credentials", () => {
  const env = { MCP_PROBE_SECRET: "short", MCP_AUTH_TOKEN: "REPLACE_WITH_TOKEN" };
  const files = [{ path: "docs/example.md", content: "short REPLACE_WITH_TOKEN" }];
  expect(findPublicSecretLeaks(env, "MCP_AUTH_TOKEN=REPLACE_WITH_TOKEN", files)).toEqual([]);
});
