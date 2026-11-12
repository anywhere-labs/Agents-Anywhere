import assert from "node:assert/strict";
import test from "node:test";
import { allowWorkbenchFrame } from "./embedded-console";

const WORKBENCH = ["aa-workbench://web"];

test("a page the site lets the instance frame may also be framed by the workbench", () => {
  const headers = {
    "Content-Security-Policy": ["frame-ancestors https://aa.example.com"],
    "Cache-Control": ["private, no-cache"],
  };
  assert.deepEqual(allowWorkbenchFrame(headers, WORKBENCH), {
    "Content-Security-Policy": ["frame-ancestors https://aa.example.com aa-workbench://web"],
    "Cache-Control": ["private, no-cache"],
  });
});

test("pages the site refuses to frame stay refused", () => {
  const refused: Record<string, string[]>[] = [
    { "content-security-policy": ["frame-ancestors 'none'"], "x-frame-options": ["DENY"] },
    { "content-security-policy": ["frame-ancestors 'none'"] },
    { "x-frame-options": ["DENY"] },
    { "content-security-policy": ["frame-ancestors https://a.test https://b.test"] },
    { "content-security-policy": ["default-src 'self'; frame-ancestors https://a.test"] },
    { "content-security-policy": ["frame-ancestors https://a.test", "frame-ancestors 'none'"] },
    { "cache-control": ["no-cache"] },
  ];
  for (const headers of refused) {
    assert.equal(allowWorkbenchFrame(headers, WORKBENCH), null, JSON.stringify(headers));
  }
  assert.equal(allowWorkbenchFrame(undefined, WORKBENCH), null);
  assert.equal(
    allowWorkbenchFrame({ "content-security-policy": ["frame-ancestors https://a.test"] }, []),
    null,
  );
});
