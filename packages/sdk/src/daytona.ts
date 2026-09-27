import { createDaytonaAdapter } from "@sandbar/provider-daytona";
import { bindAdapter, type BoundAdapter } from "./bound";

/** First-party Daytona adapter bound to a target and API key. */
export function daytona(options: { apiKey: string; target: string }): BoundAdapter {
  return bindAdapter(
    createDaytonaAdapter(),
    { target: options.target },
    { apiKey: options.apiKey },
  );
}
