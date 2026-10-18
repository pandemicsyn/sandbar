/** Markdown imported with `with { type: "text" }`; the bundler inlines it as a string. */
declare module "*.md" {
  const text: string;
  export default text;
}
