// Biscayne-night code theme for Expressive Code, used in both light and dark modes.
export const oceanDriveCodeTheme = {
  name: "ocean-drive",
  type: "dark",
  colors: {
    "editor.background": "#17203D",
    "editor.foreground": "#EAF2FF",
    "editorGroupHeader.tabsBackground": "#1E2950",
    "tab.activeBackground": "#17203D",
    "tab.inactiveBackground": "#1E2950",
    "tab.activeForeground": "#EAF2FF",
    "tab.inactiveForeground": "#8189AE",
    "tab.activeBorderTop": "#EF4F91",
    "titleBar.activeBackground": "#1E2950",
    "titleBar.activeForeground": "#8189AE",
    "terminal.background": "#17203D",
    "editor.selectionBackground": "#EF4F9147",
    "diffEditor.insertedTextBackground": "#6FE6D621",
    "diffEditor.removedTextBackground": "#FF86B724",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#8189AE", fontStyle: "italic" },
    },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "keyword.operator.new",
        "keyword.control",
      ],
      settings: { foreground: "#FF86B7" },
    },
    {
      scope: ["string", "string.quoted", "string.template", "markup.inline.raw"],
      settings: { foreground: "#6FE6D6" },
    },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#6FE6D6" } },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: "#FFB38A" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "support.class",
        "support.type",
        "variable.other.constant.property",
        "variable.other.env",
      ],
      settings: { foreground: "#BDB2FF" },
    },
    {
      scope: ["variable.other.property", "meta.object-literal.key"],
      settings: { foreground: "#EAF2FF" },
    },
    { scope: ["punctuation", "keyword.operator"], settings: { foreground: "#C7CFEA" } },
    { scope: ["markup.inserted"], settings: { foreground: "#6FE6D6" } },
    { scope: ["markup.deleted"], settings: { foreground: "#FF86B7" } },
  ],
};
