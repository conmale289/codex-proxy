import { ChatCompletionRequestSchema } from "./src/types/openai.js";
const body = {
  model: "gpt-5.5",
  messages: [{ role: "user", content: "Hello" }],
  stream: false,
  n: 1,
  reasoning_effort: "auto"
};
const parsed = ChatCompletionRequestSchema.safeParse(body);
console.log(parsed.success ? "Success" : parsed.error.message);
