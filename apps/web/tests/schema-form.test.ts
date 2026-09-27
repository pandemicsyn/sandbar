import { expect, test } from "bun:test";
import { formObject } from "../src/schema-form";

test("JSON fallback keeps scalar, array, object, and null values", () => {
  expect(formObject(null, {}, '"us"')).toBe("us");
  expect(formObject(null, {}, '["us"]')).toEqual(["us"]);
  expect(formObject(null, {}, '{"region":"us"}')).toEqual({ region: "us" });
  expect(formObject(null, {}, "null")).toBeNull();
});
