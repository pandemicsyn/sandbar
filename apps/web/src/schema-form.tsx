import { z } from "zod";
import { Field } from "./components";

const PrimitiveField = z.object({
  type: z.enum(["string", "number", "integer", "boolean"]),
  title: z.string().optional(),
  description: z.string().optional(),
  format: z.string().optional(),
  enum: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export type FormField = z.infer<typeof PrimitiveField> & {
  key: string;
  required: boolean;
};

export function formFields(schema: unknown): FormField[] | null {
  const root = z.object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()).default({}),
    required: z.array(z.string()).default([]),
  }).safeParse(schema);
  if (!root.success) return null;
  const fields: FormField[] = [];
  for (const [key, value] of Object.entries(root.data.properties)) {
    const field = PrimitiveField.safeParse(value);
    if (!field.success || (field.data.format && !["uri", "email"].includes(field.data.format)))
      return null;
    fields.push({ key, ...field.data, required: root.data.required.includes(key) });
  }
  return fields;
}

export function initialValues(fields: FormField[] | null, secret: boolean): Record<string, string> {
  if (!fields || secret) return {};
  return Object.fromEntries(fields
    .filter((field) => field.default !== undefined)
    .map((field) => [field.key, String(field.default)]));
}

export function formObject(fields: FormField[] | null, values: Record<string, string>, fallback: string): Record<string, z.infer<ReturnType<typeof z.json>>> {
  if (!fields) {
    const parsed: unknown = JSON.parse(fallback);
    return z.record(z.string(), z.json()).parse(parsed);
  }
  const result: Record<string, z.infer<ReturnType<typeof z.json>>> = {};
  for (const field of fields) {
    const value = values[field.key] ?? "";
    if (!value.trim() && field.type !== "boolean") {
      if (field.required) throw new Error(`${field.title ?? field.key} is required`);
      continue;
    }
    if (field.type === "boolean") result[field.key] = value === "true";
    else if (field.type === "number" || field.type === "integer") {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || (field.type === "integer" && !Number.isSafeInteger(numeric)))
        throw new Error(`${field.title ?? field.key} must be a valid number`);
      result[field.key] = numeric;
    } else result[field.key] = value;
  }
  return result;
}

function label(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

export function SchemaFields({
  fields,
  values,
  onChange,
  secret,
  fallback,
  onFallbackChange,
  prefix,
}: {
  fields: FormField[] | null;
  values: Record<string, string>;
  onChange(value: Record<string, string>): void;
  secret: boolean;
  fallback: string;
  onFallbackChange(value: string): void;
  prefix: string;
}) {
  if (!fields) {
    return (
      <Field
        label={secret ? "Credentials JSON" : "Configuration JSON"}
        hint={secret ? "Paste a JSON object. This field is masked and cleared after submission." : "This provider uses a complex schema. Enter a JSON object."}
        htmlFor={`${prefix}-json`}
      >
        <input
          className="input"
          id={`${prefix}-json`}
          type={secret ? "password" : "text"}
          autoComplete={secret ? "new-password" : "off"}
          spellCheck={false}
          value={fallback}
          onChange={(event) => onFallbackChange(event.target.value)}
        />
      </Field>
    );
  }
  return fields.map((field) => {
    const id = `${prefix}-${field.key}`;
    const title = field.title ?? label(field.key);
    const value = values[field.key] ?? "";
    const set = (next: string) => onChange({ ...values, [field.key]: next });
    return (
      <Field key={id} label={title} hint={field.description} htmlFor={id}>
        {field.enum ? (
          <select className="select" id={id} value={value} required={field.required} onChange={(event) => set(event.target.value)}>
            {!field.required && <option value="">Optional</option>}
            {field.enum.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        ) : field.type === "boolean" ? (
          <input id={id} type="checkbox" checked={value === "true"} onChange={(event) => set(String(event.target.checked))} />
        ) : (
          <input
            className="input"
            id={id}
            type={secret ? "password" : field.type === "number" || field.type === "integer" ? "number" : field.format === "uri" ? "url" : "text"}
            autoComplete={secret ? "new-password" : "off"}
            required={field.required}
            value={value}
            onChange={(event) => set(event.target.value)}
          />
        )}
      </Field>
    );
  });
}
