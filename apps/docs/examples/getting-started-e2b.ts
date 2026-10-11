import { Sandbar } from "sandbar-sdk";
import { e2b } from "sandbar-e2b";

const apiKey = process.env.E2B_API_KEY;

if (!apiKey) throw new Error("Set E2B_API_KEY before running this example");

const sandbar = await Sandbar.connect(e2b({ apiKey }));

try {
  await sandbar.sandboxes.with({}, async (box) => {
    const output = await box.exec(["printf", "Hello from Sandbar!\n"]);
    console.log(output.stdoutText());
  });
} finally {
  await sandbar.close();
}
