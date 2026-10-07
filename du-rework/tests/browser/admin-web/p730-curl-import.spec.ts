import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CURL_IMPORT_LIMITS, isSecretTokenName, parseCurlImport, summarizeCurlImport } from "../../../orchestrator/apps/admin-web/src/features/connectors/curl-import";
import { draftFromCurlImport } from "../../../orchestrator/apps/admin-web/src/features/connectors/state";

/**
 * P730-CURL-IMPORT (CFGADM-07) - bounded cURL text parser.
 *
 * Runner-confirmed infrastructure: this file runs under the existing
 * tests/browser/admin-web/playwright.config.ts + harness.ts. No runner, no
 * dependency and no lockfile change is added by this slice.
 *
 * Phase 1 (P730-UI-INTEGRATE) mounted CurlImportPreview into ConnectorsScreen
 * behind a modal, so tests 14-15 guard the mount statically (imports, accept-only
 * wiring, disabled save/test) and test 16 re-verifies redaction through the
 * post-accept summarize path. Driving the mounted modal in a real page still
 * needs the harness browser run - recorded as SKIP/GAP, never presented as done.
 *
 * The sibling specs in this directory need AWEB01B_URL / AWEB01B_TOKEN /
 * AWEB01B_EVIDENCE / AWEB03B_STUB because they share one Playwright process.
 */

// CJS-safe: the admin-web Playwright config transpiles specs to CJS, so
// `import.meta` is unavailable (`__dirname` is). CURL-SPEC-FIX 2026-10-04.
const SPEC_DIR = __dirname;
const PARSER_PATH = join(SPEC_DIR, "../../../orchestrator/apps/admin-web/src/features/connectors/curl-import.ts");
const PREVIEW_PATH = join(SPEC_DIR, "../../../orchestrator/apps/admin-web/src/features/connectors/curl-import-preview.tsx");
const SCREEN_PATH = join(SPEC_DIR, "../../../orchestrator/apps/admin-web/src/features/connectors/connectors-screen.tsx");

/** Single quote, kept as a character code so the fixtures stay quote-free. */
const SQ = String.fromCharCode(39);

const BEARER_SECRET = "sk-live-2f9c41ab77de0055";
const API_KEY_SECRET = "ak-prod-9931ee02c4";
const FORM_SECRET = "hunter2-do-not-print";

const GOOD_BEARER = [
  "curl -X POST https://api.vendor.example/v1/extract\\",
  "  -H " + SQ + "authorization:Bearer " + BEARER_SECRET + SQ + "\\",
  "  -H content-type:application/json\\",
  "  -F prompt=hello \\",
  "  -F api_key=" + FORM_SECRET,
].join("\n");

const GOOD_API_KEY = [
  "curl https://api.vendor.example/v1/extract\\",
  "  -H x-api-key:" + API_KEY_SECRET + "\\",
  "  --compressed\\",
  "  -F file=@C:/Users/op/private-dir/source.pdf\\",
  "  -F model=gpt-4o",
].join("\n");

const SUBS = ["$(", "`", "<(", ">("];

test.describe("P730-CURL-IMPORT bounded cURL parser", () => {
  test("1. POST + bearer auth + header + form fields import cleanly", () => {
    const result = parseCurlImport(GOOD_BEARER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.draft.httpMethod).toBe("POST");
    expect(result.draft.endpointUrl).toBe("https://api.vendor.example/v1/extract");
    expect(result.draft.auth.type).toBe("BEARER");
    expect(result.draft.auth.secretValue).toBe(BEARER_SECRET);
    expect(result.draft.headers.map((header) => header.name)).toEqual(["content-type"]);
    expect(result.draft.formFields.map((field) => field.name)).toEqual(["prompt", "api_key"]);
    expect(result.draft.formFields[1]?.secret).toBe(true);
  });

  test("2. summary leaks no secret and no full header value", () => {
    for (const text of [GOOD_BEARER, GOOD_API_KEY]) {
      const result = parseCurlImport(text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const serialized = JSON.stringify(result.summary);
      for (const secret of [BEARER_SECRET, API_KEY_SECRET, FORM_SECRET]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain("application/json");
      expect(result.summary.auth.type).not.toBe("NONE");
      expect(result.summary.auth.secretPresent).toBe(true);
      expect(result.summary.auth.preview).toBe("****" + result.draft.auth.secretValue?.slice(-4));
    }
  });

  test("3. file upload noted, directory stripped, local path never shown", () => {
    const result = parseCurlImport(GOOD_API_KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.draft.httpMethod).toBe("POST");
    expect(result.draft.auth.type).toBe("API_KEY_HEADER");
    expect(result.draft.headers).toEqual([]);
    const file = result.summary.formFields.find((field) => field.isFile);
    expect(file?.name).toBe("file");
    expect(file?.preview).toBe("@source.pdf");
    expect(JSON.stringify(result.summary)).not.toContain("private-dir");
    const codes = result.summary.notes.map((note) => note.code);
    expect(codes).toContain("FILE_NOT_IMPORTED");
    expect(codes).toContain("FLAGS_IGNORED");
  });

  test("4. malformed input fails closed with a code and a fixed message", () => {
    const malformed = [
      "",
      "   ",
      "wget https://api.vendor.example/v1/extract",
      "curl -H content-type",
      "curl -H :novalue https://api.vendor.example/v1/x",
      "curl -H bad(name):v https://api.vendor.example/v1/x",
      "curl -F bad-field https://api.vendor.example/v1/x",
      "curl --data-raw",
      "curl -X PO;ST https://api.vendor.example/v1/x",
      "curl file:///etc/passwd",
      "curl ftp://host/file",
    ];
    for (const text of malformed) {
      const result = parseCurlImport(text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toMatch(/^[A-Z_]+$/);
      expect(result.error.message.length).toBeGreaterThan(10);
    }
  });

  test("5. command substitution is rejected and never evaluated", () => {
    for (const substitution of SUBS) {
      const text = "curl -H authorization:Bearer " + substitution + " https://api.vendor.example/v1/x";
      const result = parseCurlImport(text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("COMMAND_SUBSTITUTION_UNSUPPORTED");
      expect(result.error.message).not.toContain("whoami");
    }
  });

  test("6. limits are enforced, not truncated", () => {
    const longUrl = "curl https://api.vendor.example/" + "a".repeat(CURL_IMPORT_LIMITS.maxUrlChars);
    const wideHeaders =
      "curl https://api.vendor.example/x " +
      Array.from(
        { length: CURL_IMPORT_LIMITS.maxHeaders + 1 },
        (unused, index) => "-H x-h" + index + ":v",
      ).join(" ");
    const manyTokens =
      "curl https://api.vendor.example/x " +
      Array.from(
        { length: CURL_IMPORT_LIMITS.maxTokens + 2 },
        (unused, index) => "a" + index,
      ).join(" ");

    const cases: Array<[string, string]> = [
      [longUrl, "URL_TOO_LONG"],
      [wideHeaders, "TOO_MANY_HEADERS"],
      [manyTokens, "TOO_MANY_TOKENS"],
    ];
    for (const [text, code] of cases) {
      const result = parseCurlImport(text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(code);
    }
  });

  test("7. header secret redaction: name kept, value never shown", () => {
    const result = parseCurlImport("curl -H " + SQ + "cookie: sid=abcdef012345" + SQ + " https://api.vendor.example/x");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const header = result.summary.headers.find((entry) => entry.name === "cookie");
    expect(header?.secret).toBe(true);
    expect(header?.preview).toBe("****2345");
    expect(header?.valueChars).toBe("sid=abcdef012345".length);
  });

  test("8. secret name detection does not false-positive on author", () => {
    expect(isSecretTokenName("authorization")).toBe(true);
    expect(isSecretTokenName("x-api-key")).toBe(true);
    expect(isSecretTokenName("api_key")).toBe(true);
    expect(isSecretTokenName("apikey")).toBe(true);
    expect(isSecretTokenName("session-id")).toBe(false);
    expect(isSecretTokenName("author")).toBe(false);
    expect(isSecretTokenName("prompt")).toBe(false);
  });

  test("9. preview leaf is free of storage, logging and network calls", () => {
    const source = readFileSync(PREVIEW_PATH, "utf8");
    for (const forbidden of [
      "localStorage",
      "sessionStorage",
      "console.",
      "fetch(",
      "XMLHttpRequest",
      "document.cookie",
      "indexedDB",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("parseCurlImport");
  });

  test("10. no shell, eval or network in the parser leaf", () => {
    const source = readFileSync(PARSER_PATH, "utf8");
    const forbidden = ["eval(", "new Function", "child_process", "execSync", "XMLHttpRequest", "fetch("];
    for (const needle of forbidden) {
      expect(source).not.toContain(needle);
    }
  });

  test("11. legacy parity on the happy path", () => {
    const text =
      "curl -X POST https://api.vendor.example/v1/x" +
      " -H " + SQ + "content-type: application/json" + SQ +
      " -F " + SQ + "prompt=hello" + SQ;
    const result = parseCurlImport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.draft.httpMethod).toBe("POST");
    expect(result.draft.endpointUrl).toBe("https://api.vendor.example/v1/x");
    expect(result.draft.headers).toEqual([{ name: "content-type", value: "application/json" }]);
    expect(result.draft.formFields).toEqual([{ name: "prompt", value: "hello", isFile: false, secret: false }]);
  });

  test("12. non-bearer authorization stays a header and stays masked", () => {
    const result = parseCurlImport("curl -H " + SQ + "authorization: Basic dXNlcjpwYXNz" + SQ + " https://api.vendor.example/x");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.draft.auth.type).toBe("NONE");
    expect(result.draft.auth.secretValue).toBe(null);
    expect(result.draft.headers).toEqual([{ name: "authorization", value: "Basic dXNlcjpwYXNz" }]);
    expect(JSON.stringify(result.summary)).not.toContain("dXNlcjpwYXNz");
  });

  test("13. an unterminated quote is reported without echoing the secret", () => {
    const text = "curl -H x-test:" + BEARER_SECRET + " " + SQ + "https://api.vendor.example/x";
    const result = parseCurlImport(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("UNTERMINATED_QUOTE");
    expect(result.error.message).not.toContain(BEARER_SECRET);
  });

  test("14. screen mounts the preview and stays accept-only", () => {
    const source = readFileSync(SCREEN_PATH, "utf8");
    expect(source).toContain("CurlImportPreview");
    expect(source).toContain("draftFromCurlImport");
    expect(source).toContain("Import cURL");
    // Accept-only phase 1: no network call, no save wire, no persistence.
    expect(source).not.toContain("createAdminApiClient().save");
    expect(source).not.toContain(".post(");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    // The honest GAP: save/test are rendered but disabled, never hidden fakes.
    expect(source).toContain("Save connection");
    expect(source).toContain("Test connection");
  });

  test("15. accepted draft keeps the secret masked through summarize", () => {
    const parsed = parseCurlImport(GOOD_BEARER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const accepted = draftFromCurlImport(parsed.draft, "my draft");
    expect(accepted.name).toBe("my draft");
    // The screen renders the post-accept card through this exact path.
    const serialized = JSON.stringify(summarizeCurlImport(accepted));
    expect(serialized).not.toContain(BEARER_SECRET);
    expect(serialized).not.toContain(FORM_SECRET);
    expect(serialized).toContain("****" + BEARER_SECRET.slice(-4));
    // The draft itself keeps the secret in memory for the future save wire.
    expect(accepted.auth.secretValue).toBe(BEARER_SECRET);
  });

  test("16. mount never introduces eval/shell into the screen leaf", () => {
    const source = readFileSync(SCREEN_PATH, "utf8");
    for (const needle of ["eval(", "new Function", "child_process", "execSync"]) {
      expect(source).not.toContain(needle);
    }
  });

  test("17. Q2 toggle is wired: Reveal column + aria-pressed, headers stay raw-free", () => {
    const source = readFileSync(PREVIEW_PATH, "utf8");
    expect(source).toContain("Reveal");
    expect(source).toContain("aria-pressed");
    expect(source).toContain("Show value for ");
    expect(source).toContain("Hide value for ");
    // Headers keep the hard rule: no reveal control is offered for them.
    expect(source).toContain("Imported headers");
  });

  test("18. heuristic boundary: unknown secret name stays visible, dictionary name is masked", () => {
    const text =
      "curl -X POST https://api.vendor.example/v1/x" +
      " -F author=Nguyen" +
      " -F api_key=hiddenvalue1" +
      " -F model=gpt-4o";
    const parsed = parseCurlImport(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const fields = summarizeCurlImport(parsed.draft).formFields;
    const author = fields.find((field) => field.name === "author");
    const apiKey = fields.find((field) => field.name === "api_key");
    const model = fields.find((field) => field.name === "model");
    // Not a secret name -> the operator can verify what was parsed.
    expect(author?.secret).toBe(false);
    expect(author?.preview).toBe("Nguyen");
    expect(model?.preview).toBe("gpt-4o");
    // Dictionary name -> masked in the model, not just in the view.
    expect(apiKey?.secret).toBe(true);
    expect(apiKey?.preview).toBe("****" + "hiddenvalue1".slice(-4));
    expect(JSON.stringify(fields)).not.toContain("hiddenvalue1");
  });

  test("19. both call sites hand the draft down so reveal is available", () => {
    const preview = readFileSync(PREVIEW_PATH, "utf8");
    const screen = readFileSync(SCREEN_PATH, "utf8");
    expect(preview).toContain("summary={summary} draft=");
    expect(screen).toContain("summary={summarizeCurlImport(draft)} draft={draft}");
  });
});
