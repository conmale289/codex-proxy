import { ChatCompletionRequestSchema } from "./src/types/openai.js";
const body = {
  model: "gpt-5.5",
  messages: [{ role: "user", content: "Hello" }],
  stream: false,
  n: 1,
  reasoning_effort: null,
  service_tier: "auto",
  tools: null
};
const parsed = ChatCompletionRequestSchema.safeParse(body);
console.log(parsed.success ? "Success" : JSON.stringify(parsed.error.errors, null, 2));
